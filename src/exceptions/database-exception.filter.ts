import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { QueryFailedError } from 'typeorm';

@Catch(QueryFailedError)
export class DatabaseExceptionFilter implements ExceptionFilter {
  catch(exception: QueryFailedError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const send = (status: number, message: string, extra?: Record<string, unknown>) => {
      response.setHeader('X-Status-Code', String(status));
      response.status(status).json({
        statusCode: status,
        message,
        ...(extra ?? {}),
      });
    };

    if (exception.message.includes('duplicate key')) {
      const field = exception.message.match(/Key \((.*?)\)=/)?.[1];
      const value = exception.message.match(/=\((.*?)\)/)?.[1];
      return send(HttpStatus.CONFLICT, 'Data already exists', { field, value });
    }

    if (exception.message.includes('violates not-null constraint')) {
      const field = exception.message.match(/column "(.*?)"/)?.[1];
      return send(HttpStatus.BAD_REQUEST, 'Validation failed', {
        errors: [{ field, message: 'Field is required' }],
      });
    }

    return send(HttpStatus.INTERNAL_SERVER_ERROR, 'Internal server error');
  }
}
