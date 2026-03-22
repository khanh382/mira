import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatModule } from '../chat/chat.module';
import { OpenclawAgent } from './entities/openclaw-agent.entity';
import { OpenclawThread } from './entities/openclaw-thread.entity';
import { OpenclawMessage } from './entities/openclaw-message.entity';
import { OpenclawAgentsService } from './openclaw-agents.service';
import { OpenclawRelayHttpService } from './openclaw-relay-http.service';
import { OpenclawChatService } from './openclaw-chat.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([OpenclawAgent, OpenclawThread, OpenclawMessage]),
    ChatModule,
  ],
  providers: [OpenclawAgentsService, OpenclawRelayHttpService, OpenclawChatService],
  exports: [
    TypeOrmModule,
    OpenclawAgentsService,
    OpenclawChatService,
  ],
})
export class OpenclawAgentsModule {}
