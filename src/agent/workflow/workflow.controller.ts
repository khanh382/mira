import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowStatus } from './entities/workflow.entity';
import { WorkflowNodeJoinMode } from './entities/workflow-node.entity';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { SkillsService } from '../skills/skills.service';
import { UsersService } from '../../modules/users/users.service';
import { UserLevel } from '../../modules/users/entities/user.entity';

@Controller('agent/workflows')
@UseGuards(JwtAuthGuard)
export class WorkflowController {
  constructor(
    private readonly workflowEngine: WorkflowEngineService,
    private readonly skillsService: SkillsService,
    private readonly usersService: UsersService,
  ) {}

  @Get('tool-options')
  async getToolOptions(@Req() req: { user: { uid: number } }) {
    const user = await this.usersService.findById(req.user.uid);
    const isOwner = user?.level === UserLevel.OWNER;
    const catalog = await this.skillsService.getSkillCatalog({
      displayOnly: true,
    });
    const visibleCatalog = isOwner
      ? catalog
      : catalog.filter((s) => !s.ownerOnly);

    const categories = [
      'web',
      'runtime',
      'browser',
      'media',
      'memory',
      'messaging',
      'sessions',
      'filesystem',
      'google_workspace',
      'custom',
      'clawhub',
    ];
    const googlePriority: Record<string, number> = {
      google_gmail: 1,
      google_drive: 2,
      google_docs: 3,
      google_sheets: 4,
      google_slides: 5,
      google_calendar: 6,
      google_contacts: 7,
      google_tasks: 8,
      google_forms: 9,
      google_chat: 10,
      google_keep: 11,
      google_pdf_read: 12,
      google_workspace: 99,
      google_auth_setup: 100,
    };
    const grouped = categories.map((cat) => ({
      category: cat,
      tools: visibleCatalog
        .filter((s) => s.category === cat)
        .sort((a, b) => {
          if (cat === 'google_workspace') {
            const pa = googlePriority[a.skillCode] ?? 1000;
            const pb = googlePriority[b.skillCode] ?? 1000;
            if (pa !== pb) return pa - pb;
          }
          return a.skillCode.localeCompare(b.skillCode);
        })
        .map((s) => ({
          skillCode: s.skillCode,
          skillName: s.skillName,
          displayName: s.displayName,
          description: s.description,
          sampleCode: s.sampleCode,
          minModelTier: s.minModelTier,
          ownerOnly: s.ownerOnly,
        })),
    }));

    return {
      categories,
      grouped,
      totalTools: visibleCatalog.length,
    };
  }

  @Post()
  async createWorkflow(
    @Req() req: { user: { uid: number } },
    @Body()
    body: {
      code: string;
      name: string;
      description?: string;
    },
  ) {
    return this.workflowEngine.createWorkflow({
      userId: req.user.uid,
      code: body.code,
      name: body.name,
      description: body.description,
    });
  }

  @Get()
  async listWorkflows(@Req() req: { user: { uid: number } }) {
    return this.workflowEngine.listWorkflows(req.user.uid);
  }

  @Patch(':workflowId')
  async updateWorkflowMeta(
    @Req() req: { user: { uid: number } },
    @Param('workflowId') workflowId: string,
    @Body()
    body: {
      code?: string;
      name?: string;
      description?: string | null;
    },
  ) {
    return this.workflowEngine.updateWorkflowMeta({
      workflowId,
      userId: req.user.uid,
      code: body.code,
      name: body.name,
      description: body.description,
    });
  }

  @Patch(':workflowId/status')
  async setStatus(
    @Req() req: { user: { uid: number } },
    @Param('workflowId') workflowId: string,
    @Body() body: { status: WorkflowStatus },
  ) {
    return this.workflowEngine.setWorkflowStatus({
      workflowId,
      userId: req.user.uid,
      status: body.status,
    });
  }

  @Patch(':workflowId/entry-node')
  async setEntryNode(
    @Req() req: { user: { uid: number } },
    @Param('workflowId') workflowId: string,
    @Body() body: { entryNodeId: string | null },
  ) {
    return this.workflowEngine.setEntryNode({
      workflowId,
      userId: req.user.uid,
      entryNodeId: body.entryNodeId,
    });
  }

  @Post(':workflowId/nodes')
  async addNode(
    @Req() req: { user: { uid: number } },
    @Param('workflowId') workflowId: string,
    @Body()
    body: {
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
    },
  ) {
    return this.workflowEngine.addNode({
      workflowId,
      userId: req.user.uid,
      name: body.name,
      promptTemplate: body.promptTemplate,
      toolCode: body.toolCode,
      commandCode: body.commandCode,
      modelOverride: body.modelOverride,
      maxAttempts: body.maxAttempts,
      timeoutMs: body.timeoutMs,
      joinMode: body.joinMode,
      joinExpected: body.joinExpected,
      posX: body.posX,
      posY: body.posY,
    });
  }

  @Patch(':workflowId/nodes/:nodeId')
  async updateNode(
    @Req() req: { user: { uid: number } },
    @Param('workflowId') workflowId: string,
    @Param('nodeId') nodeId: string,
    @Body()
    body: {
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
    },
  ) {
    return this.workflowEngine.updateNode({
      workflowId,
      nodeId,
      userId: req.user.uid,
      name: body.name,
      promptTemplate: body.promptTemplate,
      toolCode: body.toolCode,
      commandCode: body.commandCode,
      modelOverride: body.modelOverride,
      maxAttempts: body.maxAttempts,
      timeoutMs: body.timeoutMs,
      joinMode: body.joinMode,
      joinExpected: body.joinExpected,
      posX: body.posX,
      posY: body.posY,
    });
  }

  @Delete(':workflowId/nodes/:nodeId')
  async deleteNode(
    @Req() req: { user: { uid: number } },
    @Param('workflowId') workflowId: string,
    @Param('nodeId') nodeId: string,
  ) {
    return this.workflowEngine.deleteNode({
      workflowId,
      nodeId,
      userId: req.user.uid,
    });
  }

  @Post(':workflowId/edges')
  async addEdge(
    @Param('workflowId') workflowId: string,
    @Body()
    body: {
      fromNodeId: string;
      toNodeId: string;
      conditionExpr?: string | null;
      priority?: number;
      isDefault?: boolean;
    },
  ) {
    return this.workflowEngine.addEdge({
      workflowId,
      fromNodeId: body.fromNodeId,
      toNodeId: body.toNodeId,
      conditionExpr: body.conditionExpr,
      priority: body.priority,
      isDefault: body.isDefault,
    });
  }

  @Patch(':workflowId/edges/:edgeId')
  async updateEdge(
    @Req() req: { user: { uid: number } },
    @Param('workflowId') workflowId: string,
    @Param('edgeId') edgeId: string,
    @Body()
    body: {
      conditionExpr?: string | null;
      priority?: number;
      isDefault?: boolean;
    },
  ) {
    return this.workflowEngine.updateEdge({
      workflowId,
      edgeId,
      userId: req.user.uid,
      conditionExpr: body.conditionExpr,
      priority: body.priority,
      isDefault: body.isDefault,
    });
  }

  @Delete(':workflowId/edges/:edgeId')
  async deleteEdge(
    @Req() req: { user: { uid: number } },
    @Param('workflowId') workflowId: string,
    @Param('edgeId') edgeId: string,
  ) {
    return this.workflowEngine.deleteEdge({
      workflowId,
      edgeId,
      userId: req.user.uid,
    });
  }

  @Post(':workflowId/run')
  async runWorkflow(
    @Req() req: { user: { uid: number } },
    @Param('workflowId') workflowId: string,
    @Body()
    body: {
      input?: Record<string, unknown>;
      threadId?: string;
    },
  ) {
    return this.workflowEngine.runWorkflow({
      workflowId,
      userId: req.user.uid,
      input: body.input,
      threadId: body.threadId,
    });
  }

  @Post(':workflowId/nodes/:nodeId/run')
  async runSingleNode(
    @Req() req: { user: { uid: number } },
    @Param('workflowId') workflowId: string,
    @Param('nodeId') nodeId: string,
    @Body()
    body: {
      input?: Record<string, unknown>;
      threadId?: string;
    },
  ) {
    return this.workflowEngine.runSingleNode({
      workflowId,
      nodeId,
      userId: req.user.uid,
      input: body.input,
      threadId: body.threadId,
    });
  }

  @Get(':workflowId/runs')
  async listWorkflowRuns(
    @Req() req: { user: { uid: number } },
    @Param('workflowId') workflowId: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.workflowEngine.listWorkflowRuns({
      workflowId,
      userId: req.user.uid,
      status,
      limit: limit != null ? Number(limit) : undefined,
      offset: offset != null ? Number(offset) : undefined,
    });
  }

  @Get(':workflowId/nodes/:nodeId/runs')
  async listNodeRuns(
    @Req() req: { user: { uid: number } },
    @Param('workflowId') workflowId: string,
    @Param('nodeId') nodeId: string,
    @Query('runId') runId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.workflowEngine.listNodeRuns({
      workflowId,
      nodeId,
      userId: req.user.uid,
      runId,
      limit: limit != null ? Number(limit) : undefined,
      offset: offset != null ? Number(offset) : undefined,
    });
  }

  @Delete(':workflowId/runs')
  async deleteAllWorkflowRuns(
    @Req() req: { user: { uid: number } },
    @Param('workflowId') workflowId: string,
  ) {
    return this.workflowEngine.deleteAllWorkflowRuns({
      workflowId,
      userId: req.user.uid,
    });
  }

  @Delete(':workflowId/nodes/:nodeId/runs')
  async deleteAllNodeRuns(
    @Req() req: { user: { uid: number } },
    @Param('workflowId') workflowId: string,
    @Param('nodeId') nodeId: string,
  ) {
    return this.workflowEngine.deleteAllNodeRuns({
      workflowId,
      nodeId,
      userId: req.user.uid,
    });
  }

  @Get('runs/:runId')
  async getRun(@Req() req: { user: { uid: number } }, @Param('runId') runId: string) {
    return this.workflowEngine.getRun(runId, req.user.uid);
  }

  @Put(':workflowId/graph')
  async saveGraph(
    @Req() req: { user: { uid: number } },
    @Param('workflowId') workflowId: string,
    @Body()
    body: {
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
    },
  ) {
    if (!Array.isArray(body.nodes) || body.nodes.length === 0) {
      throw new Error(
        'Graph save requires non-empty nodes. Use PATCH /agent/workflows/:workflowId to update workflow metadata only.',
      );
    }
    return this.workflowEngine.saveGraph({
      workflowId,
      userId: req.user.uid,
      expectedVersion: body.expectedVersion,
      nodes: body.nodes,
      edges: body.edges ?? [],
      entryNodeId: body.entryNodeId,
      entryNodeClientKey: body.entryNodeClientKey,
    });
  }

  @Get(':workflowId/graph')
  async getWorkflow(
    @Req() req: { user: { uid: number } },
    @Param('workflowId') workflowId: string,
  ) {
    return this.workflowEngine.getWorkflow(workflowId, req.user.uid);
  }
}
