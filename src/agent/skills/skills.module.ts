import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscoveryModule } from '@nestjs/core';
import { Skill } from './entities/skill.entity';
import { SkillsService } from './skills.service';
import { ClawhubModule } from './clawhub/clawhub.module';

import { WebSearchSkill } from './built-in/web/web-search.skill';
import { WebFetchSkill } from './built-in/web/web-fetch.skill';
import { HttpRequestSkill } from './built-in/web/http-request.skill';
import { ExecSkill } from './built-in/runtime/exec.skill';
import { CronManageSkill } from './built-in/runtime/cron-manage.skill';
import { SkillsRegistryManageSkill } from './built-in/runtime/skills-registry-manage.skill';
import { BrowserSkill } from './built-in/browser/browser.skill';
import { BrowserDebugCleanupSkill } from './built-in/browser/browser-debug-cleanup.skill';
import { ImageUnderstandSkill } from './built-in/media/image-understand.skill';
import { PdfReadSkill } from './built-in/media/pdf-read.skill';
import { TtsSkill } from './built-in/media/tts.skill';
import { MemorySearchSkill } from './built-in/memory/memory-search.skill';
import { MemoryGetSkill } from './built-in/memory/memory-get.skill';
import { MemoryWriteSkill } from './built-in/memory/memory-write.skill';
import { TaskMemorySkill } from './built-in/memory/task-memory.skill';
import { MessageSendSkill } from './built-in/messaging/message-send.skill';
import { BotAccessManageSkill } from './built-in/messaging/bot-access-manage.skill';
import { SessionsListSkill } from './built-in/sessions/sessions-list.skill';
import { SessionsHistorySkill } from './built-in/sessions/sessions-history.skill';
import { FileReadSkill } from './built-in/filesystem/file-read.skill';

import { ChatModule } from '../../modules/chat/chat.module';
import { UsersModule } from '../../modules/users/users.module';
import { GoogleModule } from './built-in/google/google.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { LearningModule } from '../learning/learning.module';
import { WorkspaceModule } from '../../gateway/workspace/workspace.module';
import { ChannelsModule } from '../channels/channels.module';
import { BotUsersModule } from '../../modules/bot-users/bot-users.module';
import { HttpTokensModule } from '../../modules/http-tokens/http-tokens.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Skill]),
    DiscoveryModule,
    ClawhubModule,
    ChatModule,
    UsersModule,
    GoogleModule,
    LearningModule,
    WorkspaceModule,
    ChannelsModule,
    BotUsersModule,
    HttpTokensModule,
    forwardRef(() => SchedulerModule),
  ],
  providers: [
    SkillsService,
    WebSearchSkill,
    WebFetchSkill,
    HttpRequestSkill,
    ExecSkill,
    CronManageSkill,
    SkillsRegistryManageSkill,
    BrowserSkill,
    BrowserDebugCleanupSkill,
    ImageUnderstandSkill,
    PdfReadSkill,
    TtsSkill,
    MemorySearchSkill,
    MemoryGetSkill,
    MemoryWriteSkill,
    TaskMemorySkill,
    MessageSendSkill,
    BotAccessManageSkill,
    SessionsListSkill,
    SessionsHistorySkill,
    FileReadSkill,
  ],
  exports: [SkillsService],
})
export class SkillsModule {}
