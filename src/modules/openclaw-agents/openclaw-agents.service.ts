import {
  BadRequestException,
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OpenclawAgent, OpenclawAgentStatus } from './entities/openclaw-agent.entity';
import {
  CreateOpenclawAgentDto,
  UpdateOpenclawAgentDto,
  PublicOpenclawAgent,
} from './dto/openclaw-agent.dto';

@Injectable()
export class OpenclawAgentsService {
  constructor(
    @InjectRepository(OpenclawAgent)
    private readonly agentRepo: Repository<OpenclawAgent>,
  ) {}

  async listAgentsByOwner(ownerUserId: number): Promise<OpenclawAgent[]> {
    return this.agentRepo.find({
      where: { ownerUserId },
      order: { id: 'ASC' },
    });
  }

  async findAgentForOwner(
    oaId: number,
    ownerUserId: number,
  ): Promise<OpenclawAgent | null> {
    return this.agentRepo.findOne({
      where: { id: oaId, ownerUserId },
    });
  }

  async getAgentForOwner(
    oaId: number,
    ownerUserId: number,
  ): Promise<OpenclawAgent> {
    const agent = await this.findAgentForOwner(oaId, ownerUserId);
    if (!agent) {
      throw new NotFoundException('OpenClaw agent not found');
    }
    return agent;
  }

  /**
   * Chỉ chủ bản ghi oa_uid được thao tác; grantee bot không được gọi.
   */
  assertOwner(agent: OpenclawAgent, uid: number): void {
    if (agent.ownerUserId !== uid) {
      throw new ForbiddenException('Not the owner of this OpenClaw agent');
    }
  }

  async create(ownerUserId: number, dto: CreateOpenclawAgentDto): Promise<PublicOpenclawAgent> {
    if (!dto.name?.trim()) throw new BadRequestException('name là bắt buộc.');
    if (!dto.domain?.trim()) throw new BadRequestException('domain là bắt buộc.');
    if (!dto.port?.trim()) throw new BadRequestException('port là bắt buộc.');

    const agent = this.agentRepo.create({
      ownerUserId,
      name: dto.name.trim(),
      domain: dto.domain.trim(),
      port: dto.port.trim(),
      useTls: dto.useTls ?? false,
      chatPath: dto.chatPath?.trim() || null,
      gatewayToken: dto.gatewayToken?.trim() || null,
      gatewayPassword: dto.gatewayPassword?.trim() || null,
      expertise: dto.expertise?.trim() || null,
      status: OpenclawAgentStatus.ACTIVE,
    });
    const saved = await this.agentRepo.save(agent);
    return this.toPublicAgent(saved);
  }

  async update(
    oaId: number,
    ownerUserId: number,
    dto: UpdateOpenclawAgentDto,
  ): Promise<PublicOpenclawAgent> {
    const agent = await this.getAgentForOwner(oaId, ownerUserId);

    if (dto.name !== undefined) agent.name = dto.name.trim();
    if (dto.domain !== undefined) agent.domain = dto.domain.trim();
    if (dto.port !== undefined) agent.port = dto.port.trim();
    if (dto.useTls !== undefined) agent.useTls = dto.useTls;
    if (dto.chatPath !== undefined) agent.chatPath = dto.chatPath?.trim() || null;
    if (dto.expertise !== undefined) agent.expertise = dto.expertise?.trim() || null;
    if (dto.status !== undefined) agent.status = dto.status;

    // Cho phép xoá secret bằng cách truyền chuỗi rỗng hoặc null.
    if (dto.gatewayToken !== undefined) {
      agent.gatewayToken = dto.gatewayToken?.trim() || null;
    }
    if (dto.gatewayPassword !== undefined) {
      agent.gatewayPassword = dto.gatewayPassword?.trim() || null;
    }

    const saved = await this.agentRepo.save(agent);
    return this.toPublicAgent(saved);
  }

  async remove(oaId: number, ownerUserId: number): Promise<void> {
    const agent = await this.getAgentForOwner(oaId, ownerUserId);
    agent.status = OpenclawAgentStatus.DISABLED;
    await this.agentRepo.save(agent);
  }

  toPublicAgent(agent: OpenclawAgent): PublicOpenclawAgent {
    return {
      id: agent.id,
      name: agent.name,
      ownerUserId: agent.ownerUserId,
      domain: agent.domain,
      port: agent.port,
      useTls: agent.useTls,
      chatPath: agent.chatPath,
      expertise: agent.expertise,
      status: agent.status,
      lastHealthAt: agent.lastHealthAt,
      lastError: agent.lastError,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      hasGatewayToken: !!agent.gatewayToken,
      hasGatewayPassword: !!agent.gatewayPassword,
    };
  }

  async markRelaySuccess(agentId: number): Promise<void> {
    await this.agentRepo.update(agentId, {
      lastHealthAt: new Date(),
      lastError: null,
    });
  }

  async markRelayFailure(agentId: number, message: string): Promise<void> {
    await this.agentRepo.update(agentId, {
      lastError: message.slice(0, 4000),
    });
  }
}
