/**
 * Atribui às faturas os lançamentos de cartões já configurados. Idempotente:
 * pode rodar quantas vezes for preciso (só grava o que mudou).
 *
 *   pnpm --filter @financial-vellun/api db:backfill:invoices
 *
 * Necessário uma vez depois da migração `credit_card_invoices`, para cartões
 * criados antes dela; a partir daí, toda escrita de lançamento sincroniza.
 */
import { PrismaService } from '../src/prisma/prisma.service';
import { CardLedgerService } from '../src/credit-cards/card-ledger.service';

async function main() {
  const prisma = new PrismaService();
  const ledger = new CardLedgerService(prisma);
  try {
    const cards = await prisma.creditCard.findMany({
      where: {
        closingDay: { not: null },
        dueDay: { not: null },
        invoiceTrackingStart: { not: null },
      },
      select: { id: true, accountId: true },
    });
    for (const card of cards) {
      await ledger.syncCardAccount(card.accountId);
      console.log(`cartão ${card.id}: sincronizado`);
    }
    console.log(`${cards.length} cartão(ões) configurado(s) sincronizado(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
