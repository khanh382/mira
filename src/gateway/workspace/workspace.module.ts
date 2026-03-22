import { Module } from '@nestjs/common';
import { WorkspaceService } from './workspace.service';
import { BrowserDomPresetLearnService } from './browser-dom-preset-learn.service';
import { TaskMemoryService } from './task-memory.service';
import { SkillDraftEnrichmentService } from './skill-draft-enrichment.service';
import { SessionContextFocusService } from './session-context-focus.service';
import { UsersModule } from '../../modules/users/users.module';
import { ChatModule } from '../../modules/chat/chat.module';
import { ProvidersModule } from '../../agent/providers/providers.module';
import { ModelRouterModule } from '../../agent/pipeline/model-router/model-router.module';

@Module({
  imports: [UsersModule, ChatModule, ProvidersModule, ModelRouterModule],
  providers: [
    WorkspaceService,
    BrowserDomPresetLearnService,
    TaskMemoryService,
    SkillDraftEnrichmentService,
    SessionContextFocusService,
  ],
  exports: [
    WorkspaceService,
    BrowserDomPresetLearnService,
    TaskMemoryService,
    SkillDraftEnrichmentService,
    SessionContextFocusService,
  ],
})
export class WorkspaceModule {}
