import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

/**
 * Kiểm tra xem có đủ thông tin để kết nối database không
 */
export const hasDatabaseConfig = (configService: ConfigService): boolean => {
  const host = configService.get<string>('DB_HOST');
  const port = configService.get<string>('DB_PORT');
  const username = configService.get<string>('DB_USERNAME');
  const password = configService.get<string>('DB_PASSWORD');
  const database = configService.get<string>('DB_DATABASE');

  // Kiểm tra các trường bắt buộc (không rỗng)
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

export const databaseConfig = (configService: ConfigService): TypeOrmModuleOptions => {
  return {
    type: 'postgres',
    host: configService.get('DB_HOST', 'localhost'),
    port: configService.get('DB_PORT', 5432),
    username: configService.get('DB_USERNAME', 'postgres'),
    password: configService.get('DB_PASSWORD', 'postgres'),
    database: configService.get('DB_DATABASE', 'my_project'),
    entities: [__dirname + '/../**/*.entity{.ts,.js}'],
    synchronize: false,
    logging: false
  };
};
