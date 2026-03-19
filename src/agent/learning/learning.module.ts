import { Module } from '@nestjs/common';
import { VectorizationService } from './vectorization.service';
import { ExportService } from './export.service';
import { ChatModule } from '../../modules/chat/chat.module';
import { GlobalConfigModule } from '../../modules/global-config/global-config.module';

@Module({
  imports: [ChatModule, GlobalConfigModule],
  providers: [VectorizationService, ExportService],
  exports: [VectorizationService, ExportService],
})
export class LearningModule {}
