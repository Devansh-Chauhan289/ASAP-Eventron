import { PrismaClient } from '@prisma/client';

/**
 * Seeds the double-entry chart of accounts (also ensured at PaymentsModule boot) and a demo
 * user. Run with `npm run db:seed` after migrating. Safe to re-run (idempotent upserts).
 */
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const accounts = [
    { code: 'USER_CASH', name: 'User Cash' },
    { code: 'STRIPE_CLEARING', name: 'Stripe Clearing' },
    { code: 'REVENUE', name: 'Revenue' },
    { code: 'REFUNDS_PAYABLE', name: 'Refunds Payable' },
  ];
  for (const a of accounts) {
    await prisma.ledgerAccount.upsert({
      where: { code: a.code },
      create: a,
      update: {},
    });
  }
  // eslint-disable-next-line no-console
  console.log(`Seeded ${accounts.length} ledger accounts.`);
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
