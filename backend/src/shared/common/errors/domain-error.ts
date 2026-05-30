/**
 * Domain/application errors. The AllExceptionsFilter maps these to the standard
 * HTTP error envelope { error: { code, message, details, correlationId, retryable } }
 * documented in backend/API.md §1.5.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'IDEMPOTENCY_REPLAY'
  | 'BUSINESS_RULE'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'INTERNAL';

export interface ErrorDetail {
  field?: string;
  issue: string;
}

export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly httpStatus: number,
    public readonly retryable = false,
    public readonly details: ErrorDetail[] = [],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id?: string) {
    super('NOT_FOUND', `${resource}${id ? ` ${id}` : ''} not found`, 404);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'You do not have access to this resource') {
    super('FORBIDDEN', message, 403);
  }
}

export class UnauthenticatedError extends DomainError {
  constructor(message = 'Authentication required') {
    super('UNAUTHENTICATED', message, 401);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super('CONFLICT', message, 409);
  }
}

export class BusinessRuleError extends DomainError {
  constructor(message: string, details: ErrorDetail[] = []) {
    super('BUSINESS_RULE', message, 422, false, details);
  }
}

export class ProviderUnavailableError extends DomainError {
  constructor(provider: string) {
    super(
      'PROVIDER_UNAVAILABLE',
      `Provider ${provider} is temporarily unavailable`,
      503,
      true,
    );
  }
}

/** Thrown by repositories on optimistic-lock version mismatch (Rule 10). Saga retries. */
export class OptimisticLockError extends DomainError {
  constructor(aggregate: string, id: string, version: number) {
    super(
      'CONFLICT',
      `Concurrent modification of ${aggregate} ${id} (version ${version})`,
      409,
      true,
    );
  }
}

/** Thrown by domain state machines on illegal transitions (Section 4). */
export class IllegalStateTransitionError extends DomainError {
  constructor(aggregate: string, from: string, to: string) {
    super(
      'BUSINESS_RULE',
      `Illegal ${aggregate} transition: ${from} -> ${to}`,
      422,
    );
  }
}
