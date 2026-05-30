import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { LedgerDirection } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { Tx } from '@shared/prisma/prisma.tx';

export const LEDGER_ACCOUNTS = {
  USER_CASH: 'USER_CASH',
  STRIPE_CLEARING: 'STRIPE_CLEARING',
  REVENUE: 'REVENUE',
  REFUNDS_PAYABLE: 'REFUNDS_PAYABLE',
} as const;

interface EntryInput {
  accountCode: string;
  direction: LedgerDirection;
  amount: bigint;
}

/**
 * Double-entry ledger (Section 3.3 INV-P1). Every money movement posts a balanced set of
 * entries grouped by transactionId where Σ debits == Σ credits. The ledger — not booking
 * status columns — is the financial source of truth (enables reconciliation & reporting).
 */
@Injectable()
export class LedgerRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Idempotently ensure the chart of accounts exists (called at bootstrap). */
  async ensureAccounts(): Promise<void> {
    const accounts: Array<{ code: string; name: string }> = [
      { code: LEDGER_ACCOUNTS.USER_CASH, name: 'User Cash' },
      { code: LEDGER_ACCOUNTS.STRIPE_CLEARING, name: 'Stripe Clearing' },
      { code: LEDGER_ACCOUNTS.REVENUE, name: 'Revenue' },
      { code: LEDGER_ACCOUNTS.REFUNDS_PAYABLE, name: 'Refunds Payable' },
    ];
    for (const a of accounts) {
      await this.prisma.ledgerAccount.upsert({
        where: { code: a.code },
        create: a,
        update: {},
      });
    }
  }

  /**
   * Posts a balanced transaction inside the caller's tx. Throws if debits != credits
   * (defense in depth alongside the DB trigger described in §8.5).
   */
  async post(
    tx: Tx,
    input: {
      currency: string;
      paymentIntentId?: string;
      refundId?: string;
      memo: string;
      entries: EntryInput[];
    },
  ): Promise<string> {
    const debits = input.entries
      .filter((e) => e.direction === 'DEBIT')
      .reduce((s, e) => s + e.amount, 0n);
    const credits = input.entries
      .filter((e) => e.direction === 'CREDIT')
      .reduce((s, e) => s + e.amount, 0n);
    if (debits !== credits) {
      throw new Error(
        `Ledger imbalance: debits=${debits} credits=${credits} (${input.memo})`,
      );
    }

    const accounts = await tx.ledgerAccount.findMany({
      where: { code: { in: input.entries.map((e) => e.accountCode) } },
    });
    const byCode = new Map(accounts.map((a) => [a.code, a.id]));
    const transactionId = randomUUID();

    for (const e of input.entries) {
      const accountId = byCode.get(e.accountCode);
      if (!accountId) throw new Error(`Unknown ledger account: ${e.accountCode}`);
      await tx.ledgerEntry.create({
        data: {
          accountId,
          paymentIntentId: input.paymentIntentId,
          refundId: input.refundId,
          direction: e.direction,
          amount: e.amount,
          currency: input.currency,
          transactionId,
          memo: input.memo,
        },
      });
    }
    return transactionId;
  }

  /** Sum of all entries for a payment intent, signed (DEBIT +, CREDIT -). For test assertions. */
  async balanceForPaymentIntent(paymentIntentId: string): Promise<bigint> {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { paymentIntentId },
    });
    return entries.reduce(
      (s, e) => s + (e.direction === 'DEBIT' ? e.amount : -e.amount),
      0n,
    );
  }
}
