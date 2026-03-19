import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscoveryModule } from '@nestjs/core';
import { Skill } from './entities/skill.entity';
import { SkillsService } from './skills.service';
import { ClawhubModule } from './clawhub/clawhub.module';

import { WebSearchSkill } from './built-in/web/web-search.skill';
import { WebFetchSkill } from './built-in/web/web-fetch.skill';
import { ExecSkill } from './built-in/runtime/exec.skill';
import { CronManageSkill } from './built-in/runtime/cron-manage.skill';
import { BrowserSkill } from './built-in/browser/browser.skill';
import { ImageUnderstandSkill } from './built-in/media/image-understand.skill';
import { PdfReadSkill } from './built-in/media/pdf-read.skill';
import { TtsSkill } from './built-in/media/tts.skill';
import { MemorySearchSkill } from './built-in/memory/memory-search.skill';
import { MemoryGetSkill } from './built-in/memory/memory-get.skill';
import { MessageSendSkill } from './built-in/messaging/message-send.skill';
import { SessionsListSkill } from './built-in/sessions/sessions-list.skill';
import { SessionsHistorySkill } from './built-in/sessions/sessions-history.skill';

import { ChatModule } from '../../modules/chat/chat.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Skill]),
    DiscoveryModule,
    ClawhubModule,
    ChatModule,
  ],
  providers: [
    SkillsService,
    WebSearchSkill,
    WebFetchSkill,
    ExecSkill,
    CronManageSkill,
    BrowserSkill,
    ImageUnderstandSkill,
    PdfReadSkill,
    TtsSkill,
    MemorySearchSkill,
    MemoryGetSkill,
    MessageSendSkill,
    SessionsListSkill,
    SessionsHistorySkill,
  ],
  exports: [SkillsService],
})
export class SkillsModule {}
