import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { HttpToken } from './entities/http-token.entity';
import { HttpTokensService } from './http-tokens.service';
import { HttpTokensController } from './http-tokens.controller';

@Module({
  imports: [TypeOrmModule.forFeature([HttpToken]), UsersModule],
  providers: [HttpTokensService],
  controllers: [HttpTokensController],
  exports: [HttpTokensService, TypeOrmModule],
})
export class HttpTokensModule {}
