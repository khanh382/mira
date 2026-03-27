import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ModelPolicy } from './entities/model-policy.entity';
import { ModelPolicyService } from './model-policy.service';

@Module({
  imports: [TypeOrmModule.forFeature([ModelPolicy])],
  providers: [ModelPolicyService],
  exports: [ModelPolicyService, TypeOrmModule],
})
export class ModelPolicyModule {}

