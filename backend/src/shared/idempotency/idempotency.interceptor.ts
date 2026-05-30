import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { createHash } from 'crypto';
import { Observable, from, of } from 'rxjs';
import { mergeMap, tap } from 'rxjs/operators';
import { IdempotencyRepository } from './idempotency.repository';
import {
  ConflictError,
  DomainError,
} from '../common/errors/domain-error';

export const IDEMPOTENT_KEY = 'idempotent';
/** Marks a route as requiring the Idempotency-Key header (state-changing POSTs). */
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);

/**
 * Enforces and short-circuits idempotent requests (API.md §1.2, Section 10).
 * - First request with a key: claim it, run the handler, store the response.
 * - Replay (completed key): return the stored response without re-running.
 * - In-progress (key held, not finished): 409 CONFLICT, client retries later.
 *
 * Scope = `METHOD path`. The Idempotency-Key must be a UUID supplied by the client.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly repo: IdempotencyRepository,
  ) {}

  intercept(
    ctx: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> | Promise<Observable<unknown>> {
    const required = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required) return next.handle();

    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const key = req.header('idempotency-key');

    if (!key || !this.isUuid(key)) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'A valid Idempotency-Key (UUID) header is required for this operation',
        400,
      );
    }

    const scope = `${req.method} ${req.route?.path ?? req.path}`;
    const requestHash = this.hash(req.body);

    return from(this.repo.claim(scope, key, requestHash)).pipe(
      mergeMap((claim) => {
        if (claim.kind === 'replay') {
          res.status(claim.response.status);
          res.setHeader('idempotent-replayed', 'true');
          return of(claim.response.body);
        }
        if (claim.kind === 'in_progress') {
          throw new ConflictError(
            'A request with this Idempotency-Key is already being processed',
          );
        }
        // claimed — run handler, persist outcome, release on failure.
        return next.handle().pipe(
          mergeMap((body) =>
            from(
              this.repo.complete(scope, key, {
                status: res.statusCode,
                body,
              }),
            ).pipe(mergeMap(() => of(body))),
          ),
          tap({
            error: () => {
              void this.repo.release(scope, key);
            },
          }),
        );
      }),
    );
  }

  private isUuid(v: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      v,
    );
  }

  private hash(body: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(body ?? {}))
      .digest('hex');
  }
}
