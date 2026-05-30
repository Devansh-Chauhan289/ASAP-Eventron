import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { Prisma } from '@prisma/client';
import { DomainError, ErrorCode, ErrorDetail } from '../errors/domain-error';
import { CorrelationContext } from '../context/correlation.context';

interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details: ErrorDetail[];
    correlationId: string;
    retryable: boolean;
  };
}

/**
 * Maps every thrown error to the single standard error envelope (API.md §1.5).
 * Nothing leaks stack traces or internal shapes to clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const correlationId =
      CorrelationContext.correlationId() ?? 'unknown';

    const { status, body } = this.map(exception, correlationId);

    if (status >= 500) {
      this.logger.error(
        `[${correlationId}] ${body.error.code}: ${body.error.message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`[${correlationId}] ${body.error.code}: ${body.error.message}`);
    }

    res.status(status).json(body);
  }

  private map(
    exception: unknown,
    correlationId: string,
  ): { status: number; body: ErrorEnvelope } {
    // 1. Our domain errors — already carry code/status/retryable.
    if (exception instanceof DomainError) {
      return {
        status: exception.httpStatus,
        body: this.envelope(
          exception.code,
          exception.message,
          correlationId,
          exception.retryable,
          exception.details,
        ),
      };
    }

    // 2. NestJS HttpException (incl. ValidationPipe 400s).
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const resp = exception.getResponse();
      const { message, details } = this.fromHttpException(resp);
      return {
        status,
        body: this.envelope(
          this.codeForStatus(status),
          message,
          correlationId,
          false,
          details,
        ),
      };
    }

    // 3. Prisma known errors (e.g. unique violation -> CONFLICT).
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return {
          status: HttpStatus.CONFLICT,
          body: this.envelope(
            'CONFLICT',
            'Resource already exists',
            correlationId,
            false,
          ),
        };
      }
      if (exception.code === 'P2025') {
        return {
          status: HttpStatus.NOT_FOUND,
          body: this.envelope('NOT_FOUND', 'Resource not found', correlationId),
        };
      }
    }

    // 4. Unknown -> 500, opaque message.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: this.envelope(
        'INTERNAL',
        'An unexpected error occurred',
        correlationId,
      ),
    };
  }

  private fromHttpException(resp: string | object): {
    message: string;
    details: ErrorDetail[];
  } {
    if (typeof resp === 'string') return { message: resp, details: [] };
    const r = resp as { message?: string | string[]; error?: string };
    if (Array.isArray(r.message)) {
      return {
        message: 'Validation failed',
        details: r.message.map((m) => ({ issue: m })),
      };
    }
    return { message: r.message ?? r.error ?? 'Error', details: [] };
  }

  private codeForStatus(status: number): ErrorCode {
    switch (status) {
      case 400:
        return 'VALIDATION_ERROR';
      case 401:
        return 'UNAUTHENTICATED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 409:
        return 'CONFLICT';
      case 422:
        return 'BUSINESS_RULE';
      case 429:
        return 'RATE_LIMITED';
      default:
        return status >= 500 ? 'INTERNAL' : 'BUSINESS_RULE';
    }
  }

  private envelope(
    code: ErrorCode,
    message: string,
    correlationId: string,
    retryable = false,
    details: ErrorDetail[] = [],
  ): ErrorEnvelope {
    return { error: { code, message, details, correlationId, retryable } };
  }
}
