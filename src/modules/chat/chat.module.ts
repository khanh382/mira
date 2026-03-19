import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatThread } from './entities/chat-thread.entity';
import { ChatMessage } from './entities/chat-message.entity';
import { ChatService } from './chat.service';
import { ThreadsService } from './threads.service';

@Module({
  imports: [TypeOrmModule.forFeature([ChatThread, ChatMessage])],
  providers: [ChatService, ThreadsService],
  exports: [ChatService, ThreadsService],
})
export class ChatModule {}
