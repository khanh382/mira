// src/common/middleware/logger.middleware.ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const { method, originalUrl } = req;
    const startTime = Date.now(); // Đo thời gian bắt đầu request

    // Lấy địa chỉ URL của frontend từ header 'Referer' (URL trang gốc yêu cầu)
    const referer = req.headers['referer'] || 'N/A'; // Nếu không có, mặc định là 'N/A'

    // Định dạng màu sắc cho log
    const reset = '\x1b[0m';
    const blue = '\x1b[34m';
    const green = '\x1b[32m';
    const red = '\x1b[31m';
    const bgCyan = '\x1b[46m';

    // Log thông tin yêu cầu ngay khi bắt đầu
    const logMessage = `${bgCyan}🛠️ [${method}] ${originalUrl} | Referer: ${referer}${reset}`;

    // Xử lý khi request hoàn thành
    res.on('finish', () => {
      const duration = Date.now() - startTime; // Thời gian phản hồi
      const statusCode = res.statusCode;

      // Màu sắc cho status code (Xanh lá cho thành công, đỏ cho lỗi)
      const statusColor = statusCode >= 400 ? `${red}` : `${green}`;
      const resultMessage = ` ${statusColor}🎯 ${statusCode} - ${duration}ms${reset}`;

      // Log thông tin trên 1 dòng
      console.log(logMessage + resultMessage);
    });

    next(); // Chuyển sang middleware hoặc controller tiếp theo
  }
}
