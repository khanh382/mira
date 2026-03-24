import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { UserPreference } from './entities/user-preference.entity';
import { UserPreferenceLog } from './entities/user-preference-log.entity';
import { UserCode } from './entities/user-code.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { UsersAuthService } from './users-auth.service';
import { UserCodesService } from './user-codes.service';
import { BtcIdentifierService } from './btc-identifier.service';
import { UserWorkspaceBootstrapService } from './user-workspace-bootstrap.service';
import { MailService } from '../../common/mail/mail.service';
import { AuthJwtModule } from '../../common/auth-jwt.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, UserPreference, UserPreferenceLog, UserCode]),
    AuthJwtModule,
  ],
  controllers: [UsersController],
  providers: [
    UsersService,
    UsersAuthService,
    UserCodesService,
    BtcIdentifierService,
    UserWorkspaceBootstrapService,
    MailService,
  ],
  exports: [
    UsersService,
    UsersAuthService,
    UserCodesService,
    BtcIdentifierService,
    UserWorkspaceBootstrapService,
    MailService,
    TypeOrmModule,
  ],
})
export class UsersModule {}
