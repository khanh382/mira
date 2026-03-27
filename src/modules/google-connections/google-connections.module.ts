import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GoogleConnection } from './entities/google-connection.entity';
import { GoogleConnectionsService } from './google-connections.service';

@Module({
  imports: [TypeOrmModule.forFeature([GoogleConnection])],
  providers: [GoogleConnectionsService],
  exports: [GoogleConnectionsService, TypeOrmModule],
})
export class GoogleConnectionsModule {}

