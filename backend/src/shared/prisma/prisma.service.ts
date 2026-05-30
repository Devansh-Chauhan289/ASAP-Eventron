import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { Tx } from './prisma.tx';
import { TxContext } from './tx-context';

/**
 * PrismaService wraps PrismaClient. It is exported ONLY into the infrastructure layer
 * (Foundational Rule 7 — never reaches controllers; enforced by ESLint boundaries).
 *
 * `runTransaction` is the single transaction-boundary helper used by application use-cases.
 * It wraps Prisma's $transaction and marks the AsyncLocalStorage context so the runtime
 * guard can forbid external network calls inside the tx (Rule 2).
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma disconnected');
  }

  /**
   * Owns the saga-step transaction boundary. Money-moving / idempotency-claiming
   * callers pass Serializable; Postgres serialization failures are retried by the caller.
   */
  async runTransaction<T>(
    fn: (tx: Tx) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number },
  ): Promise<T> {
    return TxContext.runInTransaction(() =>
      this.$transaction(fn, {
        isolationLevel:
          options?.isolationLevel ??
          Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: options?.timeout ?? 10_000,
      }),
    );
  }
}
