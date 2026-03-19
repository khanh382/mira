import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import * as cookieParser from 'cookie-parser';
import { DatabaseExceptionFilter } from './exceptions/database-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new DatabaseExceptionFilter());

  const configService = app.get(ConfigService);

  // Lấy danh sách các domain từ biến môi trường, nếu không thì mặc định là localhost
  const frontendUrls = configService
    .get<string>('FRONTEND_URLS')
    .split(','); // Tách các URL nếu có nhiều hơn 1 domain

  const port = configService.get<number>('APP_PORT', 8080);

  // Cấu hình CORS hỗ trợ subdomain
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) {
        // Cho phép các yêu cầu không có origin (các công cụ test như Postman)
        return callback(null, true);
      }

      const isAllowed = frontendUrls.some((url) => {
        const regex = new RegExp(`^https?://([a-z0-9-]+\.)?${url.replace('http://', '').replace('https://', '')}$`);
        return regex.test(origin);
      });

      if (isAllowed) {
        callback(null, true); // Yêu cầu được phép
      } else {
        callback(new Error('Not allowed by CORS')); // Yêu cầu bị chặn
      }
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: 'Content-Type, Accept',
    credentials: true, // Cho phép cookie
  });

  app.use(cookieParser());
  await app.listen(port);
  console.log(`\uD83D\uDE80 Ứng dụng đang chạy tại: http://localhost:${port}`);
}

bootstrap();
