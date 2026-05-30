import { Injectable } from '@nestjs/common';
import { Prisma, ProviderName } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';

/**
 * Idempotent provider-call dedupe + audit (Section 12 / 7.2). Unique (provider, idempotencyKey)
 * makes a retried reservation a no-op: if a row already succeeded we return its stored response
 * instead of issuing a second provider booking (prevents orphaned/double holds).
 */
@Injectable()
export class ProviderRequestRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns the existing successful response if present, else null (caller proceeds to call). */
  async findSucceeded(
    provider: ProviderName,
    idempotencyKey: string,
  ): Promise<Record<string, unknown> | null> {
    const row = await this.prisma.providerRequest.findUnique({
      where: { provider_idempotencyKey: { provider, idempotencyKey } },
    });
    if (row?.succeeded && row.responseBody) {
      return row.responseBody as Record<string, unknown>;
    }
    return null;
  }

  async record(input: {
    provider: ProviderName;
    operation: string;
    idempotencyKey: string;
    bookingId?: string;
    requestHash: string;
    responseStatus: number;
    responseBody: Record<string, unknown>;
    succeeded: boolean;
  }): Promise<void> {
    await this.prisma.providerRequest.upsert({
      where: {
        provider_idempotencyKey: {
          provider: input.provider,
          idempotencyKey: input.idempotencyKey,
        },
      },
      create: {
        provider: input.provider,
        operation: input.operation,
        idempotencyKey: input.idempotencyKey,
        bookingId: input.bookingId,
        requestHash: input.requestHash,
        responseStatus: input.responseStatus,
        responseBody: input.responseBody as Prisma.InputJsonValue,
        succeeded: input.succeeded,
      },
      update: {
        responseStatus: input.responseStatus,
        responseBody: input.responseBody as Prisma.InputJsonValue,
        succeeded: input.succeeded,
      },
    });
  }
}