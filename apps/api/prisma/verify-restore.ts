/**
 * Conferência **somente leitura** de um banco restaurado de backup. Não altera
 * nada: responde se a restauração está íntegra antes de alguém apontar a
 * aplicação para ela.
 *
 *   DATABASE_URL=<instância restaurada> pnpm --filter @financial-vellun/api db:verify:restore
 *
 * - migrations: a última aplicada no banco é a última do repositório, nenhuma
 *   ficou pela metade e nenhuma do repositório falta;
 * - volume: contagem das tabelas principais, para comparar com a produção;
 * - frescor: o lançamento e a mensagem mais recentes, que devem bater com o
 *   horário do backup.
 *
 * Sai com código 1 se as migrations divergirem ou houver migration inacabada.
 * O procedimento completo está em docs/retencao-e-backups.md.
 */
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Host e banco do `DATABASE_URL`, sem usuário nem senha: para conferir o alvo. */
function target(): string {
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  } catch {
    return '(DATABASE_URL ausente ou inválida)';
  }
}

function repositoryMigrations(): string[] {
  const dir = join(__dirname, 'migrations');
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

function when(date: Date | null | undefined): string {
  return date ? date.toISOString() : '(nenhum)';
}

async function main() {
  console.log(`Banco conferido: ${target()}`);

  const applied = await prisma.$queryRaw<
    { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]
  >`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`;
  const finished = new Set(
    applied.filter((m) => m.finished_at && !m.rolled_back_at).map((m) => m.migration_name),
  );
  const unfinished = applied.filter((m) => !m.finished_at && !m.rolled_back_at);
  const expected = repositoryMigrations();
  const missing = expected.filter((name) => !finished.has(name));
  const last = (names: string[]) => names[names.length - 1] ?? '(nenhuma)';

  console.log('\n## Migrations');
  console.log(`- última aplicada no banco: ${last([...finished].sort())}`);
  console.log(`- última no repositório:    ${last(expected)}`);
  for (const m of unfinished) console.log(`- INACABADA: ${m.migration_name}`);
  for (const name of missing) console.log(`- FALTANDO no banco: ${name}`);

  const [users, accounts, transactions, invoices, aiMessages] = await Promise.all([
    prisma.user.count(),
    prisma.account.count(),
    prisma.transaction.count(),
    prisma.creditCardInvoice.count(),
    prisma.aiMessage.count(),
  ]);
  console.log('\n## Volume');
  console.log(`- users: ${users}`);
  console.log(`- accounts: ${accounts}`);
  console.log(`- transactions: ${transactions}`);
  console.log(`- credit_card_invoices: ${invoices}`);
  console.log(`- ai_messages: ${aiMessages}`);

  const [lastTransaction, lastMessage] = await Promise.all([
    prisma.transaction.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    prisma.aiMessage.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ]);
  console.log('\n## Frescor (deve bater com o horário do backup)');
  console.log(`- último lançamento criado: ${when(lastTransaction?.createdAt)}`);
  console.log(`- última mensagem do WhatsApp: ${when(lastMessage?.createdAt)}`);

  const ok = unfinished.length === 0 && missing.length === 0;
  console.log(
    ok
      ? '\nMigrations em dia. Falta o login com um usuário de teste (manual).'
      : '\nFALHOU: o banco restaurado não está no mesmo ponto das migrations do repositório.',
  );
  if (!ok) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
