import { Module } from '@nestjs/common';
import { BotUsersModule } from '../../../../modules/bot-users/bot-users.module';
import { UsersModule } from '../../../../modules/users/users.module';
import { WorkspaceModule } from '../../../../gateway/workspace/workspace.module';
import { GogCliService } from './gog-cli.service';
import { GoogleWorkspaceSkill } from './google-workspace.skill';
import { DriveTrackerService } from './drive-tracker.service';

@Module({
  imports: [BotUsersModule, UsersModule, WorkspaceModule],
  providers: [GogCliService, GoogleWorkspaceSkill, DriveTrackerService],
  exports: [GogCliService, GoogleWorkspaceSkill, DriveTrackerService],
})
export class GoogleModule {}
