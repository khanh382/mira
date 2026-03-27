import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import {
  IntentType,
  ModelTier,
} from '../pipeline/model-router/model-tier.enum';
import { ModelRouterService } from '../pipeline/model-router/model-router.service';
import { ProvidersService } from '../providers/providers.service';
import { SkillsService } from '../skills/skills.service';
import { GlobalConfigService } from '../../modules/global-config/global-config.service';
import { Workflow, WorkflowStatus } from './entities/workflow.entity';
import {
  WorkflowNode,
  WorkflowNodeJoinMode,
} from './entities/workflow-node.entity';
import { WorkflowEdge } from './entities/workflow-edge.entity';
import { WorkflowRun, WorkflowRunStatus } from './entities/workflow-run.entity';
import {
  WorkflowNodeRun,
  WorkflowNodeRunStatus,
} from './entities/workflow-node-run.entity';
import { WorkflowTemplateService } from './workflow-template.service';
import { WorkflowConditionService } from './workflow-condition.service';

interface INodeOutputEnvelope {
  success: boolean;
  content?: string;
  data?: unknown;
  error?: string;
  tokensUsed?: number;
  model?: string;
}

@Injectable()
export class WorkflowEngineService {
  private readonly logger = new Logger(WorkflowEngineService.name);

  constructor(
    @InjectRepository(Workflow)
    private readonly workflowRepo: Repository<Workflow>,
    @InjectRepository(WorkflowNode)
    private readonly nodeRepo: Repository<WorkflowNode>,
    @InjectRepository(WorkflowEdge)
    private readonly edgeRepo: Repository<WorkflowEdge>,
    @InjectRepository(WorkflowRun)
    private readonly runRepo: Repository<WorkflowRun>,
    @InjectRepository(WorkflowNodeRun)
    private readonly nodeRunRepo: Repository<WorkflowNodeRun>,
    private readonly dataSource: DataSource,
    private readonly router: ModelRouterService,
    private readonly providers: ProvidersService,
    private readonly skills: SkillsService,
    private readonly globalConfig: GlobalConfigService,
    private readonly template: WorkflowTemplateService,
    private readonly condition: WorkflowConditionService,
  ) {}

  async runWorkflow(args: {
    workflowId: string;
    userId: number;
    input?: Record<string, unknown>;
    threadId?: string;
  }): Promise<WorkflowRun> {
    const normalizedInput = this.normalizeRunInput(args.input);
    const workflow = await this.workflowRepo.findOne({
      where: { id: args.workflowId, userId: args.userId },
    });
    if (!workflow) throw new Error('Workflow not found');
    const isRunnableStatus =
      workflow.status === WorkflowStatus.ACTIVE ||
      workflow.status === WorkflowStatus.DRAFT;
    if (!isRunnableStatus) {
      throw new Error('Workflow status is not runnable (only draft/active)');
    }
    await this.validateWorkflowStructure(workflow.id, args.userId);

    const nodes = await this.nodeRepo.find({
      where: { workflowId: workflow.id },
      order: { createdAt: 'ASC' },
    });
    if (!nodes.length) throw new Error('Workflow has no nodes');

    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const edges = await this.edgeRepo.find({ where: { workflowId: workflow.id } });
    const edgesByFrom = new Map<string, WorkflowEdge[]>();
    const edgesByTo = new Map<string, WorkflowEdge[]>();
    for (const edge of edges) {
      const out = edgesByFrom.get(edge.fromNodeId) ?? [];
      out.push(edge);
      edgesByFrom.set(edge.fromNodeId, out);
      const incoming = edgesByTo.get(edge.toNodeId) ?? [];
      incoming.push(edge);
      edgesByTo.set(edge.toNodeId, incoming);
    }
    for (const list of edgesByFrom.values()) list.sort((a, b) => a.priority - b.priority);
    for (const list of edgesByTo.values()) list.sort((a, b) => a.priority - b.priority);

    const run = await this.runRepo.save(
      this.runRepo.create({
        workflowId: workflow.id,
        userId: args.userId,
        inputPayload: normalizedInput,
        status: WorkflowRunStatus.RUNNING,
        currentNodeId: workflow.entryNodeId ?? nodes[0].id,
        startedAt: new Date(),
      }),
    );

    const ctx: Record<string, unknown> = {
      input: normalizedInput ?? {},
      nodes: {},
      workflow: { id: workflow.id, code: workflow.code, name: workflow.name },
    };

    const entryNodeId = run.currentNodeId!;
    const state = new Map<string, 'pending' | 'queued' | 'done'>();
    for (const n of nodes) state.set(n.id, 'pending');
    const readyQueue: string[] = [entryNodeId];
    state.set(entryNodeId, 'queued');
    const activatedInbound = new Map<string, Set<string>>();
    const maxSteps = Math.max(100, nodes.length * 3);
    let processed = 0;
    let finalOutput: Record<string, unknown> | null = null;
    const outputsByNodeId: Record<string, Record<string, unknown>> = {};
    const outputsByNodeName: Record<string, Record<string, unknown>> = {};
    let workflowError: string | null = null;

    while (readyQueue.length && processed < maxSteps) {
      const batch = [...new Set(readyQueue.splice(0, readyQueue.length))];
      processed += batch.length;

      const results = await Promise.all(
        batch.map(async (nodeId) => {
          const node = nodeMap.get(nodeId);
          if (!node) throw new Error(`Node not found: ${nodeId}`);

          await this.runRepo.update(run.id, { currentNodeId: nodeId });
          const nodeResult = await this.executeNode({
            node,
            runId: run.id,
            userId: args.userId,
            threadId: args.threadId ?? `wf:${workflow.id}:${run.id}`,
            context: ctx,
          });
          return { node, nodeResult };
        }),
      );

      for (const { node, nodeResult } of results) {
        state.set(node.id, 'done');
        (ctx.nodes as Record<string, unknown>)[node.name] = nodeResult;
        (ctx.nodes as Record<string, unknown>)[node.id] = nodeResult;
        finalOutput = { nodeId: node.id, nodeName: node.name, ...nodeResult };
        outputsByNodeId[node.id] = finalOutput;
        outputsByNodeName[node.name] = finalOutput;
        if (!nodeResult.success) {
          workflowError =
            nodeResult.error ??
            `Node "${node.name}" failed without explicit error message`;
          break;
        }

        const selectedEdges = this.resolveNextEdges(node, edgesByFrom, ctx);
        for (const edge of selectedEdges) {
          const arrivedFrom = activatedInbound.get(edge.toNodeId) ?? new Set<string>();
          arrivedFrom.add(edge.fromNodeId);
          activatedInbound.set(edge.toNodeId, arrivedFrom);

          const targetNode = nodeMap.get(edge.toNodeId);
          if (!targetNode) continue;
          if (state.get(targetNode.id) !== 'pending') continue;
          if (
            this.canRunNodeByJoinMode(targetNode, activatedInbound, edgesByTo)
          ) {
            readyQueue.push(targetNode.id);
            state.set(targetNode.id, 'queued');
          }
        }
      }
      if (workflowError) break;
    }

    if (workflowError) {
      await this.runRepo.update(run.id, {
        status: WorkflowRunStatus.FAILED,
        error: workflowError,
        finalOutput: {
          lastNode: finalOutput ?? null,
          outputsByNodeId,
          outputsByNodeName,
        },
        finishedAt: new Date(),
        currentNodeId: null,
      });
      return this.runRepo.findOneOrFail({ where: { id: run.id } });
    }

    if (processed >= maxSteps) {
      await this.runRepo.update(run.id, {
        status: WorkflowRunStatus.FAILED,
        error: 'Workflow exceeded max steps',
        finishedAt: new Date(),
      });
      return this.runRepo.findOneOrFail({ where: { id: run.id } });
    }

    await this.runRepo.update(run.id, {
      status: WorkflowRunStatus.SUCCEEDED,
      finalOutput: {
        lastNode: finalOutput ?? null,
        outputsByNodeId,
        outputsByNodeName,
      },
      finishedAt: new Date(),
      currentNodeId: null,
    });
    return this.runRepo.findOneOrFail({ where: { id: run.id } });
  }

  async createWorkflow(args: {
    userId: number;
    code: string;
    name: string;
    description?: string;
  }): Promise<Workflow> {
    const existing = await this.workflowRepo.findOne({ where: { code: args.code } });
    if (existing) throw new Error('Workflow code already exists');
    return this.workflowRepo.save(
      this.workflowRepo.create({
        userId: args.userId,
        code: args.code,
        name: args.name,
        description: args.description ?? null,
        status: WorkflowStatus.DRAFT,
        version: 1,
      }),
    );
  }

  async listWorkflows(userId: number): Promise<Workflow[]> {
    return this.workflowRepo.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
    });
  }

  async updateWorkflowMeta(args: {
    workflowId: string;
    userId: number;
    code?: string;
    name?: string;
    description?: string | null;
  }): Promise<Workflow> {
    const workflow = await this.workflowRepo.findOne({
      where: { id: args.workflowId, userId: args.userId },
    });
    if (!workflow) throw new Error('Workflow not found');

    const patch: Partial<Workflow> = {};
    if (args.code != null) {
      const code = args.code.trim();
      if (!code) throw new Error('Workflow code is required');
      if (code !== workflow.code) {
        const dup = await this.workflowRepo.findOne({ where: { code } });
        if (dup) throw new Error('Workflow code already exists');
      }
      patch.code = code;
    }
    if (args.name != null) {
      const name = args.name.trim();
      if (!name) throw new Error('Workflow name is required');
      patch.name = name;
    }
    if (args.description !== undefined) patch.description = args.description;

    if (Object.keys(patch).length) {
      await this.workflowRepo.update(workflow.id, patch);
      await this.bumpVersion(workflow.id);
    }
    return this.workflowRepo.findOneOrFail({ where: { id: workflow.id } });
  }

  async setWorkflowStatus(args: {
    workflowId: string;
    userId: number;
    status: WorkflowStatus;
  }): Promise<Workflow> {
    if (args.status === WorkflowStatus.ACTIVE) {
      await this.validateWorkflowStructure(args.workflowId, args.userId);
    }
    await this.workflowRepo.update(
      { id: args.workflowId, userId: args.userId },
      { status: args.status },
    );
    const row = await this.workflowRepo.findOne({
      where: { id: args.workflowId, userId: args.userId },
    });
    if (!row) throw new Error('Workflow not found');
    await this.bumpVersion(row.id);
    return this.workflowRepo.findOneOrFail({ where: { id: row.id } });
  }

  async addNode(args: {
    workflowId: string;
    userId: number;
    name: string;
    promptTemplate?: string | null;
    toolCode?: string | null;
    commandCode?: string | null;
    modelOverride?: string | null;
    maxAttempts?: number;
    timeoutMs?: number;
    joinMode?: WorkflowNodeJoinMode;
    joinExpected?: number | null;
    posX?: number;
    posY?: number;
  }): Promise<WorkflowNode> {
    const workflow = await this.workflowRepo.findOne({
      where: { id: args.workflowId, userId: args.userId },
    });
    if (!workflow) throw new Error('Workflow not found');

    if (args.toolCode) {
      const skill = await this.skills.findByCode(args.toolCode);
      if (!skill) throw new Error(`Skill not found: ${args.toolCode}`);
    }

    const node = await this.nodeRepo.save(
      this.nodeRepo.create({
        workflowId: workflow.id,
        name: args.name,
        promptTemplate: args.promptTemplate ?? null,
        toolCode: args.toolCode ?? null,
        commandCode: args.commandCode ?? null,
        modelOverride: args.modelOverride ?? null,
        maxAttempts: args.maxAttempts ?? 5,
        timeoutMs: args.timeoutMs ?? 120000,
        joinMode: args.joinMode ?? WorkflowNodeJoinMode.NONE,
        joinExpected: args.joinExpected ?? null,
        posX: this.normalizeCanvasCoord(args.posX),
        posY: this.normalizeCanvasCoord(args.posY),
      }),
    );

    if (!workflow.entryNodeId) {
      await this.workflowRepo.update(workflow.id, { entryNodeId: node.id });
    }
    await this.bumpVersion(workflow.id);
    return node;
  }

  async updateNode(args: {
    workflowId: string;
    nodeId: string;
    userId: number;
    name?: string;
    promptTemplate?: string | null;
    toolCode?: string | null;
    commandCode?: string | null;
    modelOverride?: string | null;
    maxAttempts?: number;
    timeoutMs?: number;
    joinMode?: WorkflowNodeJoinMode;
    joinExpected?: number | null;
    posX?: number;
    posY?: number;
  }): Promise<WorkflowNode> {
    const workflow = await this.workflowRepo.findOne({
      where: { id: args.workflowId, userId: args.userId },
    });
    if (!workflow) throw new Error('Workflow not found');

    const node = await this.nodeRepo.findOne({
      where: { id: args.nodeId, workflowId: args.workflowId },
    });
    if (!node) throw new Error('Node not found');

    if (args.toolCode) {
      const skill = await this.skills.findByCode(args.toolCode);
      if (!skill) throw new Error(`Skill not found: ${args.toolCode}`);
    }

    await this.nodeRepo.update(node.id, {
      ...(args.name != null ? { name: args.name } : {}),
      ...(args.promptTemplate !== undefined
        ? { promptTemplate: args.promptTemplate }
        : {}),
      ...(args.toolCode !== undefined ? { toolCode: args.toolCode } : {}),
      ...(args.commandCode !== undefined ? { commandCode: args.commandCode } : {}),
      ...(args.modelOverride !== undefined
        ? { modelOverride: args.modelOverride }
        : {}),
      ...(args.maxAttempts != null
        ? { maxAttempts: Math.max(1, Math.min(args.maxAttempts, 5)) }
        : {}),
      ...(args.timeoutMs != null ? { timeoutMs: Math.max(1000, args.timeoutMs) } : {}),
      ...(args.joinMode !== undefined ? { joinMode: args.joinMode } : {}),
      ...(args.joinExpected !== undefined
        ? { joinExpected: args.joinExpected }
        : {}),
      ...(args.posX != null ? { posX: this.normalizeCanvasCoord(args.posX) } : {}),
      ...(args.posY != null ? { posY: this.normalizeCanvasCoord(args.posY) } : {}),
    });

    await this.bumpVersion(workflow.id);
    return this.nodeRepo.findOneOrFail({ where: { id: node.id } });
  }

  async deleteNode(args: {
    workflowId: string;
    nodeId: string;
    userId: number;
  }): Promise<{ ok: true }> {
    const workflow = await this.workflowRepo.findOne({
      where: { id: args.workflowId, userId: args.userId },
    });
    if (!workflow) throw new Error('Workflow not found');

    const node = await this.nodeRepo.findOne({
      where: { id: args.nodeId, workflowId: args.workflowId },
    });
    if (!node) return { ok: true };

    await this.edgeRepo.delete({ workflowId: args.workflowId, fromNodeId: args.nodeId });
    await this.edgeRepo.delete({ workflowId: args.workflowId, toNodeId: args.nodeId });
    await this.nodeRepo.delete(node.id);

    if (workflow.entryNodeId === args.nodeId) {
      const first = await this.nodeRepo.findOne({
        where: { workflowId: args.workflowId },
        order: { createdAt: 'ASC' },
      });
      await this.workflowRepo.update(workflow.id, {
        entryNodeId: first?.id ?? null,
      });
    }
    await this.bumpVersion(workflow.id);
    return { ok: true };
  }

  async addEdge(args: {
    workflowId: string;
    fromNodeId: string;
    toNodeId: string;
    conditionExpr?: string | null;
    priority?: number;
    isDefault?: boolean;
  }): Promise<WorkflowEdge> {
    const nodes = await this.nodeRepo.findBy({
      id: In([args.fromNodeId, args.toNodeId]),
      workflowId: args.workflowId,
    });
    if (nodes.length !== 2) {
      throw new Error('fromNodeId/toNodeId must belong to workflow');
    }
    const edge = await this.edgeRepo.save(
      this.edgeRepo.create({
        workflowId: args.workflowId,
        fromNodeId: args.fromNodeId,
        toNodeId: args.toNodeId,
        conditionExpr: args.conditionExpr ?? null,
        priority: args.priority ?? 100,
        isDefault: args.isDefault ?? false,
      }),
    );
    await this.bumpVersion(args.workflowId);
    return edge;
  }

  async getWorkflow(workflowId: string, userId: number): Promise<{
    workflow: Workflow;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
  }> {
    const workflow = await this.workflowRepo.findOne({
      where: { id: workflowId, userId },
    });
    if (!workflow) throw new Error('Workflow not found');
    const [nodes, edges] = await Promise.all([
      this.nodeRepo.find({
        where: { workflowId: workflow.id },
        order: { createdAt: 'ASC' },
      }),
      this.edgeRepo.find({
        where: { workflowId: workflow.id },
        order: { priority: 'ASC', createdAt: 'ASC' },
      }),
    ]);
    return { workflow, nodes, edges };
  }

  async getRun(runId: string, userId: number): Promise<{
    run: WorkflowRun;
    nodeRuns: WorkflowNodeRun[];
  }> {
    const anyRun = await this.runRepo.findOne({ where: { id: runId, userId } });
    if (!anyRun) throw new NotFoundException('Workflow run not found');
    if (anyRun.status === WorkflowRunStatus.DELETE) {
      throw new NotFoundException('Workflow run was soft-deleted');
    }

    const run = anyRun;
    const nodeRuns = await this.nodeRunRepo.find({
      where: {
        workflowRunId: run.id,
        status: In([
          WorkflowNodeRunStatus.RUNNING,
          WorkflowNodeRunStatus.SUCCEEDED,
          WorkflowNodeRunStatus.FAILED,
        ]),
      },
      order: { createdAt: 'ASC' },
    });
    return { run, nodeRuns };
  }

  async runSingleNode(args: {
    workflowId: string;
    nodeId: string;
    userId: number;
    input?: Record<string, unknown>;
    threadId?: string;
  }): Promise<{
    run: WorkflowRun;
    nodeRuns: WorkflowNodeRun[];
  }> {
    const normalizedInput = this.normalizeRunInput(args.input);
    const workflow = await this.workflowRepo.findOne({
      where: { id: args.workflowId, userId: args.userId },
    });
    if (!workflow) throw new Error('Workflow not found');
    const isRunnableStatus =
      workflow.status === WorkflowStatus.ACTIVE ||
      workflow.status === WorkflowStatus.DRAFT;
    if (!isRunnableStatus) {
      throw new Error('Workflow status is not runnable (only draft/active)');
    }

    const node = await this.nodeRepo.findOne({
      where: { id: args.nodeId, workflowId: args.workflowId },
    });
    if (!node) throw new Error('Node not found');

    const run = await this.runRepo.save(
      this.runRepo.create({
        workflowId: workflow.id,
        userId: args.userId,
        inputPayload: normalizedInput,
        status: WorkflowRunStatus.RUNNING,
        currentNodeId: node.id,
        startedAt: new Date(),
      }),
    );

    const ctx: Record<string, unknown> = {
      input: normalizedInput ?? {},
      nodes: {},
      workflow: { id: workflow.id, code: workflow.code, name: workflow.name },
    };
    const nodeResult = await this.executeNode({
      node,
      runId: run.id,
      userId: args.userId,
      threadId: args.threadId ?? `wf:${workflow.id}:${run.id}:single-node`,
      context: ctx,
    });
    await this.runRepo.update(run.id, {
      status: nodeResult.success
        ? WorkflowRunStatus.SUCCEEDED
        : WorkflowRunStatus.FAILED,
      finalOutput: {
        nodeId: node.id,
        nodeName: node.name,
        ...nodeResult,
      } as Record<string, unknown>,
      error: nodeResult.success ? null : (nodeResult.error ?? 'Node failed'),
      finishedAt: new Date(),
      currentNodeId: null,
    });
    return this.getRun(run.id, args.userId);
  }

  async listWorkflowRuns(args: {
    workflowId: string;
    userId: number;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    items: WorkflowRun[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const workflow = await this.workflowRepo.findOne({
      where: { id: args.workflowId, userId: args.userId },
    });
    if (!workflow) throw new Error('Workflow not found');

    const qb = this.runRepo
      .createQueryBuilder('r')
      .where('r.workflow_id = :workflowId', { workflowId: args.workflowId })
      .andWhere('r.uid = :userId', { userId: args.userId })
      .andWhere('r.status != :deletedStatus', {
        deletedStatus: WorkflowRunStatus.DELETE,
      });

    if (args.status) {
      qb.andWhere('r.status = :status', { status: args.status });
    }

    const limit = Math.max(1, Math.min(args.limit ?? 20, 200));
    const offset = Math.max(0, args.offset ?? 0);
    qb.orderBy('r.createdAt', 'DESC').skip(offset).take(limit);

    const [items, total] = await qb.getManyAndCount();
    return { items, total, limit, offset };
  }

  async listNodeRuns(args: {
    workflowId: string;
    nodeId: string;
    userId: number;
    runId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    items: WorkflowNodeRun[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const workflow = await this.workflowRepo.findOne({
      where: { id: args.workflowId, userId: args.userId },
    });
    if (!workflow) throw new Error('Workflow not found');

    const node = await this.nodeRepo.findOne({
      where: { id: args.nodeId, workflowId: args.workflowId },
    });
    if (!node) throw new Error('Node not found');

    const qb = this.nodeRunRepo
      .createQueryBuilder('nr')
      .innerJoin(WorkflowRun, 'wr', 'wr.id = nr.workflow_run_id')
      .where('nr.node_id = :nodeId', { nodeId: args.nodeId })
      .andWhere('wr.workflow_id = :workflowId', { workflowId: args.workflowId })
      .andWhere('wr.uid = :userId', { userId: args.userId })
      .andWhere('wr.status != :deletedRunStatus', {
        deletedRunStatus: WorkflowRunStatus.DELETE,
      })
      .andWhere('nr.status != :deletedNodeStatus', {
        deletedNodeStatus: WorkflowNodeRunStatus.DELETE,
      });

    if (args.runId) {
      qb.andWhere('nr.workflow_run_id = :runId', { runId: args.runId });
    }

    const limit = Math.max(1, Math.min(args.limit ?? 20, 200));
    const offset = Math.max(0, args.offset ?? 0);
    qb.orderBy('nr.createdAt', 'DESC').skip(offset).take(limit);

    const [items, total] = await qb.getManyAndCount();
    return { items, total, limit, offset };
  }

  async deleteAllWorkflowRuns(args: {
    workflowId: string;
    userId: number;
  }): Promise<{
    workflowRunsUpdated: number;
    nodeRunsUpdated: number;
  }> {
    const workflow = await this.workflowRepo.findOne({
      where: { id: args.workflowId, userId: args.userId },
    });
    if (!workflow) throw new Error('Workflow not found');

    const runIdsQb = this.runRepo
      .createQueryBuilder('r')
      .select('r.id')
      .where('r.workflow_id = :workflowId', { workflowId: args.workflowId })
      .andWhere('r.uid = :userId', { userId: args.userId })
      .andWhere('r.status != :deletedStatus', {
        deletedStatus: WorkflowRunStatus.DELETE,
      });

    const nodeRunsResult = await this.nodeRunRepo
      .createQueryBuilder()
      .update(WorkflowNodeRun)
      .set({ status: WorkflowNodeRunStatus.DELETE })
      .where(`workflow_run_id IN (${runIdsQb.getQuery()})`)
      .andWhere('status != :deletedNodeStatus')
      .setParameters({
        ...runIdsQb.getParameters(),
        deletedNodeStatus: WorkflowNodeRunStatus.DELETE,
      })
      .execute();

    const runsResult = await this.runRepo
      .createQueryBuilder()
      .update(WorkflowRun)
      .set({ status: WorkflowRunStatus.DELETE })
      .where('workflow_id = :workflowId', { workflowId: args.workflowId })
      .andWhere('uid = :userId', { userId: args.userId })
      .andWhere('status != :deletedStatus', {
        deletedStatus: WorkflowRunStatus.DELETE,
      })
      .execute();

    return {
      workflowRunsUpdated: runsResult.affected ?? 0,
      nodeRunsUpdated: nodeRunsResult.affected ?? 0,
    };
  }

  async deleteAllNodeRuns(args: {
    workflowId: string;
    nodeId: string;
    userId: number;
  }): Promise<{
    nodeRunsUpdated: number;
  }> {
    const workflow = await this.workflowRepo.findOne({
      where: { id: args.workflowId, userId: args.userId },
    });
    if (!workflow) throw new Error('Workflow not found');
    const node = await this.nodeRepo.findOne({
      where: { id: args.nodeId, workflowId: args.workflowId },
    });
    if (!node) throw new Error('Node not found');

    const nodeRunsResult = await this.nodeRunRepo
      .createQueryBuilder()
      .update(WorkflowNodeRun)
      .set({ status: WorkflowNodeRunStatus.DELETE })
      .where('node_id = :nodeId', { nodeId: args.nodeId })
      .andWhere('status != :deletedNodeStatus', {
        deletedNodeStatus: WorkflowNodeRunStatus.DELETE,
      })
      .andWhere(
        `workflow_run_id IN (
          SELECT id FROM workflow_runs
          WHERE workflow_id = :workflowId
            AND uid = :userId
            AND status != :deletedRunStatus
        )`,
        {
          workflowId: args.workflowId,
          userId: args.userId,
          deletedRunStatus: WorkflowRunStatus.DELETE,
        },
      )
      .execute();

    return {
      nodeRunsUpdated: nodeRunsResult.affected ?? 0,
    };
  }

  private async executeNode(args: {
    node: WorkflowNode;
    runId: string;
    userId: number;
    threadId: string;
    context: Record<string, unknown>;
  }): Promise<INodeOutputEnvelope> {
    const resolvedPrompt = this.template.render(args.node.promptTemplate, args.context);
    const resolvedCommand = this.template.render(args.node.commandCode, args.context);
    const maxAttempts =
      args.node.maxAttempts && args.node.maxAttempts > 0
        ? Math.min(args.node.maxAttempts, 5)
        : 5;

    let lastError = 'Unknown error';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const started = Date.now();
      const nodeRun = await this.nodeRunRepo.save(
        this.nodeRunRepo.create({
          workflowRunId: args.runId,
          nodeId: args.node.id,
          attemptNo: attempt,
          resolvedPrompt: resolvedPrompt ?? null,
          resolvedCommand: resolvedCommand ?? null,
          status: WorkflowNodeRunStatus.RUNNING,
        }),
      );

      try {
        const output = !args.node.toolCode
          ? await this.executeWithoutTool(args.userId, resolvedPrompt)
          : await this.executeWithTool({
              userId: args.userId,
              threadId: args.threadId,
              runId: args.runId,
              toolCode: args.node.toolCode,
              resolvedCommand,
              resolvedPrompt,
            });

        await this.nodeRunRepo.update(nodeRun.id, {
          status: WorkflowNodeRunStatus.SUCCEEDED,
          output: output as any,
          durationMs: Date.now() - started,
        });
        return output;
      } catch (e) {
        lastError = (e as Error).message;
        await this.nodeRunRepo.update(nodeRun.id, {
          status: WorkflowNodeRunStatus.FAILED,
          error: lastError,
          durationMs: Date.now() - started,
        });
      }
    }

    return { success: false, error: lastError };
  }

  async updateEdge(args: {
    workflowId: string;
    edgeId: string;
    userId: number;
    conditionExpr?: string | null;
    priority?: number;
    isDefault?: boolean;
  }): Promise<WorkflowEdge> {
    const workflow = await this.workflowRepo.findOne({
      where: { id: args.workflowId, userId: args.userId },
    });
    if (!workflow) throw new Error('Workflow not found');

    const edge = await this.edgeRepo.findOne({
      where: { id: args.edgeId, workflowId: args.workflowId },
    });
    if (!edge) throw new Error('Edge not found');

    await this.edgeRepo.update(edge.id, {
      ...(args.conditionExpr !== undefined
        ? { conditionExpr: args.conditionExpr }
        : {}),
      ...(args.priority != null ? { priority: args.priority } : {}),
      ...(args.isDefault != null ? { isDefault: args.isDefault } : {}),
    });
    await this.bumpVersion(args.workflowId);
    return this.edgeRepo.findOneOrFail({ where: { id: edge.id } });
  }

  async deleteEdge(args: {
    workflowId: string;
    edgeId: string;
    userId: number;
  }): Promise<{ ok: true }> {
    const workflow = await this.workflowRepo.findOne({
      where: { id: args.workflowId, userId: args.userId },
    });
    if (!workflow) throw new Error('Workflow not found');

    await this.edgeRepo.delete({ id: args.edgeId, workflowId: args.workflowId });
    await this.bumpVersion(args.workflowId);
    return { ok: true };
  }

  async setEntryNode(args: {
    workflowId: string;
    userId: number;
    entryNodeId: string | null;
  }): Promise<Workflow> {
    const workflow = await this.workflowRepo.findOne({
      where: { id: args.workflowId, userId: args.userId },
    });
    if (!workflow) throw new NotFoundException('Workflow not found');

    if (args.entryNodeId) {
      const uuidV4Like =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidV4Like.test(args.entryNodeId)) {
        throw new BadRequestException(
          'entryNodeId must be a persisted node UUID. If UI is using temporary clientKey, send entryNodeClientKey via PUT /agent/workflows/:workflowId/graph instead.',
        );
      }
      const node = await this.nodeRepo.findOne({
        where: { id: args.entryNodeId, workflowId: args.workflowId },
      });
      if (!node) {
        throw new BadRequestException('Entry node must belong to workflow');
      }
    }
    await this.workflowRepo.update(workflow.id, { entryNodeId: args.entryNodeId });
    await this.bumpVersion(workflow.id);
    return this.workflowRepo.findOneOrFail({ where: { id: workflow.id } });
  }

  async saveGraph(args: {
    workflowId: string;
    userId: number;
    expectedVersion?: number;
    nodes: Array<{
      id?: string;
      clientKey?: string;
      name: string;
      promptTemplate?: string | null;
      toolCode?: string | null;
      commandCode?: string | null;
      modelOverride?: string | null;
      maxAttempts?: number;
      timeoutMs?: number;
      joinMode?: WorkflowNodeJoinMode;
      joinExpected?: number | null;
      posX?: number;
      posY?: number;
    }>;
    edges: Array<{
      id?: string;
      fromNodeId?: string;
      toNodeId?: string;
      fromClientKey?: string;
      toClientKey?: string;
      conditionExpr?: string | null;
      priority?: number;
      isDefault?: boolean;
    }>;
    entryNodeId?: string | null;
    entryNodeClientKey?: string | null;
  }): Promise<{
    workflow: Workflow;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    nodeKeyMap: Record<string, string>;
  }> {
    if (!Array.isArray(args.nodes) || args.nodes.length === 0) {
      throw new Error(
        'Graph payload requires non-empty nodes. Use PATCH /agent/workflows/:workflowId for rename/metadata updates.',
      );
    }
    let stage = 'transaction-start';
    try {
      return await this.dataSource.transaction(async (tx) => {
      const workflowRepo = tx.getRepository(Workflow);
      const nodeRepo = tx.getRepository(WorkflowNode);
      const edgeRepo = tx.getRepository(WorkflowEdge);

      stage = 'load-workflow';
      const workflow = await workflowRepo.findOne({
        where: { id: args.workflowId, userId: args.userId },
      });
      if (!workflow) throw new Error('Workflow not found');

      // Soft version handling for canvas UX:
      // when drag/drop triggers near-simultaneous autosaves, strict mismatch causes noisy 500.
      // We keep monotonic version bump below and apply latest-write-wins semantics.

      stage = 'load-existing-nodes';
      const existingNodes = await nodeRepo.find({
        where: { workflowId: args.workflowId },
      });
      const existingById = new Map(existingNodes.map((n) => [n.id, n]));
      const keptIds = new Set<string>();
      const nodeKeyMap: Record<string, string> = {};

      stage = 'upsert-nodes';
      for (const inputNode of args.nodes) {
        if (!inputNode.name?.trim()) throw new Error('Node name is required');
        if (inputNode.toolCode) {
          const hasBuiltInRunner = !!this.skills.getRunner(inputNode.toolCode);
          const skillRow = await this.skills.findByCode(inputNode.toolCode);
          if (!hasBuiltInRunner && !skillRow) {
            throw new Error(
              `Invalid toolCode "${inputNode.toolCode}". ` +
                'toolCode must be a concrete skillCode (e.g. web_fetch, memory_search), not category (web/runtime/browser/...).',
            );
          }
        }

        if (inputNode.id && existingById.has(inputNode.id)) {
          await nodeRepo.update(inputNode.id, {
            name: inputNode.name,
            promptTemplate: inputNode.promptTemplate ?? null,
            toolCode: inputNode.toolCode ?? null,
            commandCode: inputNode.commandCode ?? null,
            modelOverride: inputNode.modelOverride ?? null,
            maxAttempts: Math.max(
              1,
              Math.min(inputNode.maxAttempts ?? 5, 5),
            ),
            timeoutMs: Math.max(1000, inputNode.timeoutMs ?? 120000),
            joinMode: inputNode.joinMode ?? WorkflowNodeJoinMode.NONE,
            joinExpected: inputNode.joinExpected ?? null,
            posX: this.normalizeCanvasCoord(inputNode.posX),
            posY: this.normalizeCanvasCoord(inputNode.posY),
          });
          keptIds.add(inputNode.id);
          if (inputNode.clientKey) nodeKeyMap[inputNode.clientKey] = inputNode.id;
          continue;
        }

        const created = await nodeRepo.save(
          nodeRepo.create({
            workflowId: args.workflowId,
            name: inputNode.name,
            promptTemplate: inputNode.promptTemplate ?? null,
            toolCode: inputNode.toolCode ?? null,
            commandCode: inputNode.commandCode ?? null,
            modelOverride: inputNode.modelOverride ?? null,
            maxAttempts: Math.max(1, Math.min(inputNode.maxAttempts ?? 5, 5)),
            timeoutMs: Math.max(1000, inputNode.timeoutMs ?? 120000),
            joinMode: inputNode.joinMode ?? WorkflowNodeJoinMode.NONE,
            joinExpected: inputNode.joinExpected ?? null,
            posX: this.normalizeCanvasCoord(inputNode.posX),
            posY: this.normalizeCanvasCoord(inputNode.posY),
          }),
        );
        keptIds.add(created.id);
        if (inputNode.clientKey) nodeKeyMap[inputNode.clientKey] = created.id;
      }

      stage = 'delete-missing-nodes';
      const toDelete = existingNodes
        .filter((n) => !keptIds.has(n.id))
        .map((n) => n.id);
      if (toDelete.length) {
        await nodeRepo.delete({ id: In(toDelete) });
      }

      stage = 'replace-edges';
      await edgeRepo.delete({ workflowId: args.workflowId });
      for (const inputEdge of args.edges) {
        const fromNodeId =
          inputEdge.fromNodeId ??
          (inputEdge.fromClientKey ? nodeKeyMap[inputEdge.fromClientKey] : null);
        const toNodeId =
          inputEdge.toNodeId ??
          (inputEdge.toClientKey ? nodeKeyMap[inputEdge.toClientKey] : null);
        if (!fromNodeId || !toNodeId) {
          throw new Error('Edge requires from/to node id (or clientKey mapping)');
        }

        await edgeRepo.save(
          edgeRepo.create({
            workflowId: args.workflowId,
            fromNodeId,
            toNodeId,
            conditionExpr: inputEdge.conditionExpr ?? null,
            priority: inputEdge.priority ?? 100,
            isDefault: inputEdge.isDefault ?? false,
          }),
        );
      }

      stage = 'update-workflow';
      const entryNodeId =
        args.entryNodeId ??
        (args.entryNodeClientKey ? nodeKeyMap[args.entryNodeClientKey] : null) ??
        workflow.entryNodeId;

      await workflowRepo.update(workflow.id, {
        entryNodeId: entryNodeId ?? null,
        version: workflow.version + 1,
      });

      stage = 'validate-graph';
      await this.validateWorkflowStructure(args.workflowId, args.userId, {
        workflowRepo,
        nodeRepo,
        edgeRepo,
      });
      stage = 'load-result';
      const [wf, nodes, edges] = await Promise.all([
        workflowRepo.findOneOrFail({ where: { id: workflow.id } }),
        nodeRepo.find({ where: { workflowId: args.workflowId } }),
        edgeRepo.find({ where: { workflowId: args.workflowId } }),
      ]);
      return { workflow: wf, nodes, edges, nodeKeyMap };
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown graph save error';
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `saveGraph failed at stage=${stage} workflowId=${args.workflowId} userId=${args.userId}: ${message}`,
        stack,
      );
      if (error instanceof HttpException) {
        throw error;
      }
      throw new InternalServerErrorException(
        `saveGraph failed at "${stage}": ${message}`,
      );
    }
  }

  private async executeWithoutTool(
    userId: number,
    resolvedPrompt: string | null,
  ): Promise<INodeOutputEnvelope> {
    if (!resolvedPrompt?.trim()) {
      throw new Error('Node prompt is required when toolCode is null');
    }

    const route = await this.router.resolveModel(userId, IntentType.REASONING, {
      skillTier: ModelTier.SKILL,
    });
    const model = route.model;
    const cfg = await this.globalConfig.getConfig();
    const persona = cfg?.brandPersonaMd?.trim();

    const messages = [
      {
        role: 'system' as const,
        content:
          (persona ? `${persona}\n\n` : '') +
          'Bạn là agent của workflow engine. Trả lời chính xác, ngắn gọn, bám ngữ cảnh.',
      },
      { role: 'user' as const, content: resolvedPrompt },
    ];

    const response = await this.providers.chat({
      model,
      messages,
      temperature: 0.2,
    });
    return {
      success: true,
      content: response.content,
      data: { content: response.content },
      tokensUsed: response.usage?.totalTokens ?? 0,
      model,
    };
  }

  private async executeWithTool(args: {
    userId: number;
    threadId: string;
    runId: string;
    toolCode: string;
    resolvedCommand: string | null;
    resolvedPrompt: string | null;
  }): Promise<INodeOutputEnvelope> {
    const runSkill = async (params: Record<string, unknown>) => {
      return this.skills.executeSkill(args.toolCode, {
        userId: args.userId,
        threadId: args.threadId,
        runId: args.runId,
        parameters: params,
      });
    };

    const tryParseCommandJson = (
      raw: string | null,
    ): Record<string, unknown> | null => {
      if (!raw?.trim()) return null;
      const txt = raw.trim();
      if (!txt.startsWith('{') || !txt.endsWith('}')) return null;
      try {
        const parsed = JSON.parse(txt);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // keep null and fallback to legacy command string mapping below
      }
      return null;
    };

    if (args.resolvedCommand?.trim()) {
      const commandObject = tryParseCommandJson(args.resolvedCommand);
      const first = await runSkill(
        commandObject ?? {
          command: args.resolvedCommand,
          code: args.resolvedCommand,
          input: args.resolvedCommand,
        },
      );
      if (first.success) {
        return { success: true, data: first.data, content: JSON.stringify(first.data ?? {}) };
      }
      if (!args.resolvedPrompt?.trim()) {
        throw new Error(first.error ?? 'Skill execution failed (command mode)');
      }
    }

    if (!args.resolvedPrompt?.trim()) {
      throw new Error('Prompt fallback is empty');
    }

    const second = await runSkill({
      query: args.resolvedPrompt,
      prompt: args.resolvedPrompt,
      input: args.resolvedPrompt,
      content: args.resolvedPrompt,
    });
    if (!second.success) {
      throw new Error(second.error ?? 'Skill execution failed');
    }

    return { success: true, data: second.data, content: JSON.stringify(second.data ?? {}) };
  }

  private resolveNextEdges(
    node: WorkflowNode,
    edgesByFrom: Map<string, WorkflowEdge[]>,
    context: Record<string, unknown>,
  ): WorkflowEdge[] {
    const edges = edgesByFrom.get(node.id) ?? [];
    if (!edges.length) return [];

    const conditionEdges = edges.filter((e) => !e.isDefault);
    const matched = conditionEdges.filter((edge) =>
      this.condition.evaluate(edge.conditionExpr, context),
    );
    if (matched.length > 0) return matched;

    const fallback = edges.find((e) => e.isDefault);
    return fallback ? [fallback] : [];
  }

  private canRunNodeByJoinMode(
    node: WorkflowNode,
    activatedInbound: Map<string, Set<string>>,
    edgesByTo: Map<string, WorkflowEdge[]>,
  ): boolean {
    const inboundActivated = activatedInbound.get(node.id);
    const activatedCount = inboundActivated?.size ?? 0;
    if (activatedCount <= 0) return false;

    const mode = node.joinMode ?? WorkflowNodeJoinMode.NONE;
    if (mode === WorkflowNodeJoinMode.NONE || mode === WorkflowNodeJoinMode.WAIT_ANY) {
      return true;
    }

    const allIncoming = edgesByTo.get(node.id) ?? [];
    const expected =
      node.joinExpected && node.joinExpected > 0
        ? node.joinExpected
        : allIncoming.length;
    return activatedCount >= Math.max(1, expected);
  }

  private async validateWorkflowStructure(
    workflowId: string,
    userId: number,
    repos?: {
      workflowRepo?: Repository<Workflow>;
      nodeRepo?: Repository<WorkflowNode>;
      edgeRepo?: Repository<WorkflowEdge>;
    },
  ): Promise<void> {
    const workflowRepo = repos?.workflowRepo ?? this.workflowRepo;
    const nodeRepo = repos?.nodeRepo ?? this.nodeRepo;
    const edgeRepo = repos?.edgeRepo ?? this.edgeRepo;

    const workflow = await workflowRepo.findOne({
      where: { id: workflowId, userId },
    });
    if (!workflow) throw new Error('Workflow not found');

    const [nodes, edges] = await Promise.all([
      nodeRepo.find({ where: { workflowId } }),
      edgeRepo.find({ where: { workflowId } }),
    ]);
    if (!nodes.length) throw new Error('Workflow must have at least one node');

    const nodeIdSet = new Set(nodes.map((n) => n.id));
    const entryNodeId = workflow.entryNodeId ?? nodes[0].id;
    if (!nodeIdSet.has(entryNodeId)) {
      throw new Error('entry_node_id is invalid for this workflow');
    }

    const defaultPerFrom = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    for (const n of nodes) adjacency.set(n.id, []);

    for (const edge of edges) {
      if (!nodeIdSet.has(edge.fromNodeId) || !nodeIdSet.has(edge.toNodeId)) {
        throw new Error('Edge contains node outside workflow');
      }
      adjacency.get(edge.fromNodeId)!.push(edge.toNodeId);
      if (edge.isDefault) {
        defaultPerFrom.set(
          edge.fromNodeId,
          (defaultPerFrom.get(edge.fromNodeId) ?? 0) + 1,
        );
      }
      if (edge.conditionExpr && !edge.conditionExpr.trim()) {
        throw new Error(`Edge ${edge.id} has empty condition expression`);
      }
    }

    for (const [fromNodeId, count] of defaultPerFrom.entries()) {
      if (count > 1) {
        throw new Error(`Node ${fromNodeId} has more than one default edge`);
      }
    }

    const state = new Map<string, number>(); // 0=unvisited,1=visiting,2=done
    const dfs = (nodeId: string): boolean => {
      const s = state.get(nodeId) ?? 0;
      if (s === 1) return true;
      if (s === 2) return false;
      state.set(nodeId, 1);
      for (const nxt of adjacency.get(nodeId) ?? []) {
        if (dfs(nxt)) return true;
      }
      state.set(nodeId, 2);
      return false;
    };
    for (const n of nodes) {
      if ((state.get(n.id) ?? 0) === 0 && dfs(n.id)) {
        throw new Error('Workflow graph has cycle (not supported)');
      }
    }
  }

  private async bumpVersion(workflowId: string): Promise<void> {
    await this.workflowRepo
      .createQueryBuilder()
      .update(Workflow)
      .set({ updatedAt: () => 'NOW()', version: () => '"version" + 1' as any })
      .where('id = :id', { id: workflowId })
      .execute();
  }

  private normalizeCanvasCoord(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return Math.round(value);
  }

  private normalizeRunInput(
    input?: Record<string, unknown>,
  ): Record<string, unknown> | null {
    if (!input || typeof input !== 'object') return null;

    const sample = {
      newsUrl: 'https://example.com/news',
      title: 'Daily update',
      websiteApiUrl: 'https://api.example.com/posts',
    } as const;

    const keys = Object.keys(input);
    const isExactSample =
      keys.length === 3 &&
      keys.includes('newsUrl') &&
      keys.includes('title') &&
      keys.includes('websiteApiUrl') &&
      input.newsUrl === sample.newsUrl &&
      input.title === sample.title &&
      input.websiteApiUrl === sample.websiteApiUrl;

    if (isExactSample) return null;
    return input;
  }
}
