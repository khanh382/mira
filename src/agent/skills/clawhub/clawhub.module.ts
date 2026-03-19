import { Module } from '@nestjs/common';
import { ClawhubLoaderService } from './clawhub-loader.service';

@Module({
  providers: [ClawhubLoaderService],
  exports: [ClawhubLoaderService],
})
export class ClawhubModule {}
