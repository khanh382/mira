import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const statusCode = exception.getStatus
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const exRes = exception.getResponse();
    let message: string;
    let extra: Record<string, unknown> = {};

    if (typeof exRes === 'string') {
      message = exRes;
    } else if (typeof exRes === 'object' && exRes !== null) {
      const obj = exRes as Record<string, unknown>;
      message =
        typeof obj['message'] === 'string'
          ? obj['message']
          : Array.isArray(obj['message'])
            ? (obj['message'] as string[]).join('; ')
            : exception.message;
      const { message: _m, statusCode: _s, error: _e, ...rest } = obj;
      void _m;
      void _s;
      void _e;
      extra = rest;
    } else {
      message = exception.message;
    }

    res.setHeader('X-Status-Code', String(statusCode));
    res.status(statusCode).json({
      statusCode,
      message,
      ...extra,
    });
  }
}
