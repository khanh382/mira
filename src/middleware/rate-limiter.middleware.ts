// src/middleware/rate-limiter.middleware.ts
import { Injectable, NestMiddleware, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

interface RateLimitInfo {
  count: number;
  firstRequestTime: number;
}

@Injectable()
export class RateLimiterMiddleware implements NestMiddleware {
  private readonly requestMap = new Map<string, RateLimitInfo>();
  private readonly WINDOW_SIZE_IN_MINUTES = 1; // Thời gian cửa sổ (phút)
  private readonly MAX_REQUESTS = 100; // Số request tối đa trong cửa sổ

  use(req: Request, res: Response, next: NextFunction) {
    const ip = req.ip;
    const now = Date.now();
    const windowSize = this.WINDOW_SIZE_IN_MINUTES * 60 * 1000; // Chuyển đổi phút sang milliseconds

    // Lấy thông tin rate limit của IP hiện tại
    const rateLimitInfo = this.requestMap.get(ip);

    if (!rateLimitInfo) {
      // Đây là request đầu tiên từ IP này
      this.requestMap.set(ip, {
        count: 1,
        firstRequestTime: now,
      });
      return next();
    }

    // Kiểm tra xem cửa sổ thời gian cũ đã hết hạn chưa
    if (now - rateLimitInfo.firstRequestTime > windowSize) {
      // Reset nếu đã hết cửa sổ thời gian
      this.requestMap.set(ip, {
        count: 1,
        firstRequestTime: now,
      });
      return next();
    }

    // Tăng số lượng request và kiểm tra giới hạn
    if (rateLimitInfo.count >= this.MAX_REQUESTS) {
      // Tính thời gian còn lại của cửa sổ
      const timeLeft = Math.ceil(
        (windowSize - (now - rateLimitInfo.firstRequestTime)) / 1000 / 60
      );

      // Set rate limit headers
      res.header('X-RateLimit-Limit', this.MAX_REQUESTS.toString());
      res.header('X-RateLimit-Remaining', '0');
      res.header(
        'X-RateLimit-Reset',
        new Date(rateLimitInfo.firstRequestTime + windowSize).toUTCString()
      );

      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Too many requests, please try again after ${timeLeft} minutes`,
          timeLeft,
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    // Tăng số lượng request
    rateLimitInfo.count++;
    this.requestMap.set(ip, rateLimitInfo);

    // Set rate limit headers
    res.header('X-RateLimit-Limit', this.MAX_REQUESTS.toString());
    res.header(
      'X-RateLimit-Remaining',
      (this.MAX_REQUESTS - rateLimitInfo.count).toString()
    );
    res.header(
      'X-RateLimit-Reset',
      new Date(rateLimitInfo.firstRequestTime + windowSize).toUTCString()
    );

    next();
  }
}
