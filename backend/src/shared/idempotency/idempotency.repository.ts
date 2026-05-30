import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface StoredResponse {
  status: number;
  body: unknown;
}

export type ClaimResult =
  | { kind: 'claimed' } // first time — proceed
  | { kind: 'in_progress' } // another request holds the key, not finished
  | { kind: 'replay'; response: StoredResponse }; // completed — replay stored response

/**
 * Durable idempotency store (platform.IdempotencyKey) backing the Idempotency-Key header
 * (API.md §1.2, Section 10). PostgreSQL is the source of truth; the unique PK (scope,key)
 * makes the claim race-safe under concurrency.
 */
@Injectable()
export class IdempotencyRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Atomically claim the key, or report it's in-progress / replayable. */
  async claim(
    scope: string,
    key: string,
    requestHash: string,
  ): Promise<ClaimResult> {
    try {
      await this.prisma.idempotencyKey.create({
        data: { scope, key, requestHash, lockedAt: new Date() },
      });
      return { kind: 'claimed' };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const existing = await this.prisma.idempotencyKey.findUnique({
          where: { scope_key: { scope, key } },
        });
        if (existing?.completedAt && existing.responseStatus != null) {
          return {
            kind: 'replay',
            response: {
              status: existing.responseStatus,
              body: existing.responseBody,
            },
          };
        }
        return { kind: 'in_progress' };
      }
      throw e;
    }
  }

  async complete(
    scope: string,
    key: string,
    response: StoredResponse,
  ): Promise<void> {
    await this.prisma.idempotencyKey.update({
      where: { scope_key: { scope, key } },
      data: {
        responseStatus: response.status,
        responseBody: response.body as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });
  }

  /** Release a claim that failed before completion so the client can retry. */
  async release(scope: string, key: string): Promise<void> {
    await this.prisma.idempotencyKey
      .delete({ where: { scope_key: { scope, key } } })
      .catch(() => undefined);
  }
}
