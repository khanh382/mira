import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OpenclawAgent } from './entities/openclaw-agent.entity';

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
