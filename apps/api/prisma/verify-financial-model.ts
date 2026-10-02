/**
 * Conferência **somente leitura** da migração do modelo financeiro
 * (docs/adrs/0018). Não altera nada.
 *
 *   DATABASE_URL=<banco migrado> pnpm --filter @financial-vellun/api db:verify:financial-model
 *
 * Rode contra uma cópia restaurada de backup (docs/retencao-e-backups.md),
 * nunca direto em produção:
 *
 * - **saldo**: para cada conta comum, o saldo pela regra antiga recalculada
 *   hoje (confirmados com data até hoje) contra o saldo pela regra nova
 *   (liquidações + transferências). A migração foi escrita para que os dois
 *   sejam iguais; diferença é erro de migração e sai com código 1. À parte,
 *   lista as contas cujo saldo **gravado** estava defasado (o cron antigo
 *   ainda não tinha rodado no dia): isso não é erro, o primeiro recálculo
 *   corrige;
 * - **conciliação**: quantas liquidações foram inferidas porque a data chegou
 *   (`legacy_matured`) e quantos usuários terão itens a revisar;
 * - **ambiguidades históricas**: séries parceladas sem a parcela 1 (data da
 *   compra aproximada), cartões sem configuração (dívida desconhecida),
 *   cartões com lançamentos anteriores ao controle e sem posição inicial
 *   (candidatos a informar a fatura anterior), faturas pagas acima do cobrado,
 *   receitas parceladas gravadas antes de o parcelamento ficar só para despesa.
 */
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

const money = (value: string | number | null) =>
  `R$ ${Number(value ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  console.log(`Banco conferido: ${target()}`);

  const [table] = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT to_regclass('public.transaction_settlements') IS NOT NULL AS exists`;
  if (!table.exists) {
    console.error('A migração 20261002120100_financial_model_tables ainda não foi aplicada.');
    process.exitCode = 1;
    return;
  }

  const balances = await prisma.$queryRaw<
    { id: string; stored: string; computed: string; oldRule: string; type: string }[]
  >`
    SELECT a."id", a."type"::text AS type, a."current_balance"::text AS stored,
           (a."initial_balance" + COALESCE(s."total", 0) + COALESCE(l."total", 0))::text AS computed,
           (a."initial_balance" + COALESCE(o."total", 0) + COALESCE(l."total", 0))::text AS "oldRule"
      FROM "accounts" a
      LEFT JOIN (
        SELECT "account_id",
               SUM(CASE WHEN "type" = 'expense' THEN -"amount" ELSE "amount" END) AS "total"
          FROM "transactions"
         WHERE "status" = 'confirmed' AND "type" IN ('income', 'expense', 'refund')
           AND "transaction_date" <= (now() AT TIME ZONE 'America/Sao_Paulo')::date
         GROUP BY 1
      ) o ON o."account_id" = a."id"
      LEFT JOIN (
        SELECT s."account_id",
               SUM(CASE WHEN t."type" = 'expense' THEN -s."amount" ELSE s."amount" END) AS "total"
          FROM "transaction_settlements" s
          JOIN "transactions" t ON t."id" = s."transaction_id"
         WHERE s."status" = 'active' AND s."kind" = 'payment'
           AND t."status" = 'confirmed' AND t."type" IN ('income', 'expense', 'refund')
         GROUP BY 1
      ) s ON s."account_id" = a."id"
      LEFT JOIN (
        SELECT "account_id",
               SUM(CASE WHEN "transfer_direction" = 'in' THEN "amount" ELSE -"amount" END) AS "total"
          FROM "transactions"
         WHERE "type" = 'transfer' AND "status" = 'confirmed' AND "transfer_direction" IS NOT NULL
         GROUP BY 1
      ) l ON l."account_id" = a."id"
     WHERE a."type" <> 'credit_card'
     ORDER BY 1`;
  const drift = balances.filter((b) => Number(b.computed) !== Number(b.oldRule));
  const stale = balances.filter((b) => Number(b.stored) !== Number(b.oldRule));
  const [{ accounts }] = await prisma.$queryRaw<{ accounts: bigint }[]>`
    SELECT COUNT(*) AS accounts FROM "accounts" WHERE "type" <> 'credit_card'`;

  console.log('\n## Saldo das contas comuns (regra antiga hoje × regra nova)');
  console.log(`- contas conferidas: ${accounts}`);
  console.log(`- divergentes (erro de migração): ${drift.length}`);
  for (const row of drift.slice(0, 20)) {
    console.log(
      `  - ${row.id} (${row.type}): regra antiga ${money(row.oldRule)} · regra nova ${money(row.computed)}`,
    );
  }
  if (drift.length > 20) console.log(`  … e mais ${drift.length - 20}`);
  console.log(`- saldo gravado defasado (corrigido no primeiro recálculo): ${stale.length}`);
  for (const row of stale.slice(0, 20)) {
    console.log(`  - ${row.id}: gravado ${money(row.stored)} · hoje ${money(row.oldRule)}`);
  }

  const origins = await prisma.$queryRaw<
    { origin: string; count: bigint; total: string; users: bigint }[]
  >`
    SELECT "origin"::text AS origin, COUNT(*) AS count, SUM("amount")::text AS total,
           COUNT(DISTINCT "user_id") AS users
      FROM "transaction_settlements"
     WHERE "status" = 'active'
     GROUP BY 1 ORDER BY 1`;
  console.log('\n## Liquidações por origem');
  for (const o of origins) {
    console.log(`- ${o.origin}: ${o.count} (${money(o.total)}), ${o.users} usuário(s)`);
  }
  const [review] = await prisma.$queryRaw<{ count: bigint; users: bigint }[]>`
    SELECT COUNT(*) AS count, COUNT(DISTINCT "user_id") AS users
      FROM "transaction_settlements" WHERE "needs_review" AND "status" = 'active'`;
  console.log(`- a revisar na conciliação: ${review.count} item(ns) de ${review.users} usuário(s)`);

  const [open] = await prisma.$queryRaw<{ overdue: bigint; future: bigint; forecast: bigint }[]>`
    SELECT COUNT(*) FILTER (WHERE t."transaction_date" < (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS overdue,
           COUNT(*) FILTER (WHERE t."transaction_date" >= (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS future,
           COUNT(*) FILTER (WHERE t."forecast") AS forecast
      FROM "transactions" t JOIN "accounts" a ON a."id" = t."account_id"
     WHERE a."type" <> 'credit_card' AND t."status" = 'confirmed'
       AND t."type" IN ('income', 'expense') AND t."settled_amount" < t."amount"`;
  console.log('\n## Em aberto em conta comum');
  console.log(
    `- vencidos: ${open.overdue} · a vencer: ${open.future} · previsões: ${open.forecast}`,
  );

  const [series] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(DISTINCT t."series_id") AS count
      FROM "transactions" t
     WHERE t."recurrence_type" = 'parcelado' AND t."series_id" IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM "transactions" f
          WHERE f."series_id" = t."series_id" AND f."installment_number" = 1
       )`;
  const [orphans] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) AS count FROM "transactions"
     WHERE "recurrence_type" = 'parcelado' AND "series_id" IS NOT NULL AND "purchase_id" IS NULL`;
  const [pendingCards] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) AS count FROM "credit_cards"
     WHERE "closing_day" IS NULL OR "due_day" IS NULL OR "invoice_tracking_start" IS NULL`;
  const [preControl] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(DISTINCT c."id") AS count
      FROM "credit_cards" c
      JOIN "transactions" t ON t."account_id" = c."account_id"
     WHERE c."invoice_tracking_start" IS NOT NULL
       AND t."status" = 'confirmed' AND t."type" = 'expense'
       AND t."transaction_date" < c."invoice_tracking_start"
       AND NOT EXISTS (
         SELECT 1 FROM "transactions" o
          WHERE o."account_id" = c."account_id" AND o."type" IN ('opening_debt', 'opening_credit')
            AND o."status" = 'confirmed'
       )`;
  const [overpaid] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) AS count FROM (
      SELECT i."id"
        FROM "credit_card_invoices" i
        LEFT JOIN "card_payments" p ON p."invoice_id" = i."id" AND p."status" = 'active'
       GROUP BY i."id"
      HAVING COALESCE(SUM(p."amount"), 0) > (
        SELECT COALESCE(SUM(CASE WHEN t."type" IN ('expense', 'opening_debt') THEN t."amount" ELSE -t."amount" END), 0)
          FROM "transactions" t
         WHERE t."invoice_id" = i."id" AND t."status" = 'confirmed'
           AND t."type" IN ('expense', 'refund', 'opening_debt', 'opening_credit')
      )
    ) x`;
  // Parcelamento passou a ser só de despesa (docs/adrs/0020); as antigas seguem valendo.
  const [incomeSeries] = await prisma.$queryRaw<{ count: bigint; users: bigint }[]>`
    SELECT COUNT(DISTINCT "series_id") AS count, COUNT(DISTINCT "user_id") AS users
      FROM "transactions"
     WHERE "recurrence_type" = 'parcelado' AND "type" = 'income' AND "status" = 'confirmed'`;

  console.log('\n## Ambiguidades históricas');
  console.log(`- séries parceladas sem a parcela 1 (data da compra aproximada): ${series.count}`);
  console.log(`- parcelas sem compra vinculada (deveria ser 0): ${orphans.count}`);
  console.log(`- cartões sem configuração (dívida desconhecida): ${pendingCards.count}`);
  console.log(`- cartões com compras antes do controle e sem posição inicial: ${preControl.count}`);
  console.log(`- faturas pagas acima do cobrado (crédito a aplicar): ${overpaid.count}`);
  console.log(
    `- receitas parceladas anteriores à regra (seguem funcionando): ${incomeSeries.count} série(s) de ${incomeSeries.users} usuário(s)`,
  );

  if (drift.length > 0 || Number(orphans.count) > 0) {
    console.error('\nDivergência entre a regra antiga e a nova: confira antes de liberar.');
    process.exitCode = 1;
  } else {
    console.log('\nOK: saldo de toda conta comum igual pela regra nova.');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
