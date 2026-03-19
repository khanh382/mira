import { Controller, Get, Post, Body } from '@nestjs/common';
import { AgentService } from './agent.service';

@Controller('agent')
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Get('status')
  getStatus() {
    return this.agentService.getStatus();
  }

  // TODO: Add endpoints for:
  // POST /agent/message — send a message to the agent
  // POST /agent/reset — reset session
  // GET /agent/sessions — list sessions
  // GET /agent/skills — list available skills
}
