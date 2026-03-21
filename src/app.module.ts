import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { databaseConfig } from './config/database.config';
import { appConfig } from './config/app.config';
import { AppController } from './app.controller';
import { AppService } from './app.service';

// Feature Modules
import { UsersModule } from './modules/users/users.module';
import { BotUsersModule } from './modules/bot-users/bot-users.module';
import { ChatModule } from './modules/chat/chat.module';
import { GlobalConfigModule } from './modules/global-config/global-config.module';

// Agent System
import { AgentModule } from './agent/agent.module';

// Gateway Layer
import { GatewayModule } from './gateway/gateway.module';

const shouldConnectDatabase = (): boolean => {
  const host = process.env.DB_HOST;
  const port = process.env.DB_PORT;
  const username = process.env.DB_USERNAME;
  const password = process.env.DB_PASSWORD;
  const database = process.env.DB_DATABASE;

  return !!(
    host &&
    port &&
    username &&
    password &&
    database &&
    host.trim() !== '' &&
    username.trim() !== '' &&
    password.trim() !== '' &&
    database.trim() !== ''
  );
};

const getImports = () => {
  const imports: any[] = [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
  ];

  if (shouldConnectDatabase()) {
    imports.push(
      TypeOrmModule.forRootAsync({
        useFactory: (configService: ConfigService) =>
          databaseConfig(configService),
        inject: [ConfigService],
      }),
    );

    imports.push(UsersModule, BotUsersModule, ChatModule, GlobalConfigModule);

    console.log(
      '✅ Database configuration detected - TypeORM will be initialized',
    );
  } else {
    console.log(
      '⚠️  Database configuration not found - TypeORM will be skipped',
    );
  }

  // Agent system (hooks, channels, providers, skills, pipeline)
  imports.push(AgentModule);

  // Gateway layer (REST, WebSocket, Webhooks — cùng port với HTTP server)
  if (shouldConnectDatabase()) {
    imports.push(GatewayModule);
    console.log('✅ Gateway layer enabled (REST + WebSocket + Webhooks)');
  }

  return imports;
};

@Module({
  imports: getImports(),
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    appConfig(consumer);
  }
}
