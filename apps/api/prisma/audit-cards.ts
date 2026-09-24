/**
 * Auditoria **somente leitura** dos dados de cartão legados. Não altera nada:
 * lista o que a separação Contas/Cartões não corrige sozinha, para revisão.
 *
 *   pnpm --filter @financial-vellun/api db:audit:cards
 *
 * - contas `credit_card` sem cartão (órfãs; a migração da fase 1 as converte);
 * - receitas lançadas em conta de cartão;
 * - despesas em conta comum com "fatura"/"cartão" na descrição (possíveis
 *   pagamentos de fatura antigos, registrados como despesa);
 * - cartões arquivados com lançamentos.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PAYMENT_HINTS = ['fatura', 'cartão', 'cartao'];

function formatBrl(value: unknown): string {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function section(title: string, rows: string[]) {
  console.log(`\n## ${title} (${rows.length})`);
  for (const row of rows) console.log(`- ${row}`);
}

async function main() {
  const orphans = await prisma.account.findMany({
    where: { type: 'credit_card', creditCard: null },
    include: { user: { select: { email: true, profileType: true } } },
    orderBy: { createdAt: 'asc' },
  });
  section(
    'Contas de cartão sem cartão (órfãs)',
    orphans.map(
      (a) => `${a.id} "${a.name}" — ${a.user.email} (${a.user.profileType}), ativa: ${a.isActive}`,
    ),
  );

  const incomeOnCards = await prisma.transaction.findMany({
    where: { type: 'income', status: 'confirmed', account: { type: 'credit_card' } },
    include: { account: { select: { name: true } } },
    orderBy: { transactionDate: 'asc' },
  });
  section(
    'Receitas em conta de cartão',
    incomeOnCards.map(
      (t) =>
        `${t.id} ${t.transactionDate.toISOString().slice(0, 10)} ${formatBrl(t.amount)} ` +
        `"${t.description}" em "${t.account.name}"`,
    ),
  );

  const possiblePayments = await prisma.transaction.findMany({
    where: {
      type: 'expense',
      status: 'confirmed',
      account: { type: { not: 'credit_card' } },
      OR: PAYMENT_HINTS.map((hint) => ({
        description: { contains: hint, mode: 'insensitive' as const },
      })),
    },
    include: { account: { select: { name: true } } },
    orderBy: { transactionDate: 'asc' },
  });
  section(
    'Despesas em conta comum que parecem pagamento de fatura',
    possiblePayments.map(
      (t) =>
        `${t.id} ${t.transactionDate.toISOString().slice(0, 10)} ${formatBrl(t.amount)} ` +
        `"${t.description}" em "${t.account.name}"`,
    ),
  );

  const archived = await prisma.creditCard.findMany({
    where: { account: { isActive: false } },
    include: {
      account: {
        select: {
          name: true,
          _count: { select: { transactions: { where: { status: 'confirmed' } } } },
        },
      },
    },
  });
  section(
    'Cartões arquivados com lançamentos',
    archived
      .filter((c) => c.account._count.transactions > 0)
      .map((c) => `${c.id} "${c.account.name}" — ${c.account._count.transactions} lançamento(s)`),
  );

  const pending = await prisma.creditCard.count({
    where: {
      OR: [{ closingDay: null }, { dueDay: null }, { invoiceTrackingStart: null }],
    },
  });
  console.log(`\nCartões em configuração pendente: ${pending}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
