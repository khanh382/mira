// app.config.ts
import { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { LoggerMiddleware } from '../middleware/logger.middleware';
// import { AuthMiddleware } from '../middleware/auth.middleware';
import { RateLimiterMiddleware } from '../middleware/rate-limiter.middleware';

export const appConfig = (consumer: MiddlewareConsumer): void => {
  consumer
    .apply(LoggerMiddleware)  // Áp dụng middleware logger cho tất cả các route
    .forRoutes('*');

  // consumer
  //   .apply(AuthMiddleware)  // Áp dụng middleware xác thực cho các route "api/*"
  //   .forRoutes('api/*');  // Chỉ bảo vệ các route "api/*"
    
  consumer
    .apply(RateLimiterMiddleware)  // Áp dụng middleware rate limiter
    .forRoutes('*'); // Áp dụng cho tất cả routes
};
