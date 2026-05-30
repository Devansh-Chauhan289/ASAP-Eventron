import { Prisma } from '@prisma/client';

/**
 * The transaction-scoped Prisma client handed from a use-case down to repositories.
 * Repositories accept this `tx` so multi-write saga steps join ONE $transaction
 * (Foundational Rule 2 & 7). They never open their own transaction for saga steps.
 */
export type Tx = Prisma.TransactionClient;
