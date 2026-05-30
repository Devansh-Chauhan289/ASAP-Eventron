import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { CorrelationContext } from '../context/correlation.context';

/**
 * Establishes the per-request correlation context (Section 14). Honors an inbound
 * X-Correlation-Id (e.g. from the client or API Gateway) or generates one, and echoes
 * it back so clients can quote it to support.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const correlationId =
      (req.header('x-correlation-id') as string | undefined) ?? randomUUID();
    const requestId = randomUUID();
    res.setHeader('x-correlation-id', correlationId);
    res.setHeader('x-request-id', requestId);

    CorrelationContext.run({ correlationId, requestId }, () => next());
  }
}
