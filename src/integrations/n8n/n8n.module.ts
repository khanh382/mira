import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { N8nDispatch } from './entities/n8n-dispatch.entity';
import { N8nClientService } from './n8n-client.service';
import { N8nDispatchService } from './n8n-dispatch.service';
import { N8nApiKey } from './entities/n8n-api-key.entity';
import { N8nApiKeysService } from './n8n-api-keys.service';

@Module({
  imports: [TypeOrmModule.forFeature([N8nDispatch, N8nApiKey])],
  providers: [N8nClientService, N8nDispatchService, N8nApiKeysService],
  exports: [N8nClientService, N8nDispatchService, N8nApiKeysService, TypeOrmModule],
})
export class N8nModule {}

