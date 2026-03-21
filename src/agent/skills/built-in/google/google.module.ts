import { Module } from '@nestjs/common';
import { BotUsersModule } from '../../../../modules/bot-users/bot-users.module';
import { UsersModule } from '../../../../modules/users/users.module';
import { WorkspaceModule } from '../../../../gateway/workspace/workspace.module';
import { GogCliService } from './gog-cli.service';
import { GoogleWorkspaceSkill } from './google-workspace.skill';
import { GoogleAuthSetupSkill } from './google-auth-setup.skill';
import { DriveTrackerService } from './drive-tracker.service';

@Module({
  imports: [BotUsersModule, UsersModule, WorkspaceModule],
  providers: [
    GogCliService,
    GoogleWorkspaceSkill,
    GoogleAuthSetupSkill,
    DriveTrackerService,
  ],
  exports: [
    GogCliService,
    GoogleWorkspaceSkill,
    GoogleAuthSetupSkill,
    DriveTrackerService,
  ],
})
export class GoogleModule {}
