import { Module } from '@nestjs/common';
import { VectorizationService } from './vectorization.service';
import { ExportService } from './export.service';
import { MemoryCompactionService } from './memory-compaction.service';
import { DailyNotesConsolidationService } from './daily-notes-consolidation.service';
import { PreferenceExtractorService } from './preference-extractor.service';
import { PreferenceScoringService } from './preference-scoring.service';
import { InteractionMemoryService } from './interaction-memory.service';
import { ChatModule } from '../../modules/chat/chat.module';
import { GlobalConfigModule } from '../../modules/global-config/global-config.module';
import { ProvidersModule } from '../providers/providers.module';
import { WorkspaceModule } from '../../gateway/workspace/workspace.module';
import { UsersModule } from '../../modules/users/users.module';
import { ModelRouterModule } from '../pipeline/model-router/model-router.module';

@Module({
  imports: [
    ChatModule,
    GlobalConfigModule,
    ProvidersModule,
    WorkspaceModule,
    UsersModule,
    ModelRouterModule,
  ],
  providers: [
    VectorizationService,
    ExportService,
    MemoryCompactionService,
    DailyNotesConsolidationService,
    PreferenceExtractorService,
    PreferenceScoringService,
    InteractionMemoryService,
  ],
  exports: [
    VectorizationService,
    ExportService,
    MemoryCompactionService,
    DailyNotesConsolidationService,
    PreferenceExtractorService,
    PreferenceScoringService,
    InteractionMemoryService,
  ],
})
export class LearningModule {}
