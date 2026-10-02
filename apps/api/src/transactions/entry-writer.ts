import { BadRequestException } from '@nestjs/common';
import {
  Prisma,
  RecurrenceFrequency,
  RecurrenceType,
  SettlementOrigin,
  TransactionSource,
  TransactionStatus,
} from '@prisma/client';

import { isFutureDay } from '../common/date.util';
import { Db, cents } from '../common/db';
import { buildSeries } from './recurrence-series';
import { recordSettlement } from './settlements.service';

/** O que um lançamento novo informa, venha do formulário ou do WhatsApp. */
export interface EntryInput {
  userId: string;
  account: { id: string; type: string };
  categoryId: string | null;
  type: 'income' | 'expense';
  description: string;
  source: TransactionSource;
  status?: TransactionStatus;
  rawInput?: string | null;
  recurrenceType?: RecurrenceType;
  recurrenceFrequency?: RecurrenceFrequency;
  installments?: number;
  recurrenceMonths?: number;
  /** No parcelado, o total da compra; no fixo, o de cada ocorrência. */
  amount: number;
  /** Data da (primeira) ocorrência: vencimento ou previsão. */
  firstDate: Date;
  /** Data do fato, quando difere do vencimento (conta de luz de setembro que vence em outubro). */
  eventDate?: Date;
  /** Previsão em vez de obrigação. Padrão: só no fixo. */
  forecast?: boolean;
  /**
   * Já foi pago/recebido (a primeira ocorrência). Padrão: lançamento avulso,
   * em conta comum, com data até hoje — o "gastei 50 no mercado". Em cartão é
   * ignorado: quem paga a compra é a fatura.
   */
  settle?: boolean;
  settlementOrigin: SettlementOrigin;
  idempotencyKey?: string | null;
}

/** Padrão de `settle` quando o cliente não informa (compatível com clientes antigos). */
export function defaultSettle(input: {
  account: { type: string };
  recurrenceType?: RecurrenceType;
  firstDate: Date;
  status?: TransactionStatus;
}) {
  return (
    input.account.type !== 'credit_card' &&
    (input.recurrenceType ?? 'avulso') === 'avulso' &&
    !isFutureDay(input.firstDate) &&
    (input.status ?? 'confirmed') === 'confirmed'
  );
}

/**
 * Grava um lançamento — ou a série inteira — na transação `tx` (docs/adrs/0018):
 *
 * - **Parcelado:** cria a compra (`installment_purchases`, `id = seriesId`)
 *   com data e total próprios; as parcelas apontam para ela e têm como data do
 *   fato a data da compra. O total é dividido em centavos exatos.
 * - **Fixo:** cada ocorrência tem a própria data como fato e nasce como
 *   previsão, salvo `forecast: false` (compromisso firmado).
 * - **À vista:** com `settle`, a primeira ocorrência nasce paga — a
 *   liquidação é gravada junto, sem passo a mais para o usuário.
 *
 * Quem chama trava as contas, recalcula o saldo e sincroniza a fatura na
 * mesma `tx`. A chave de idempotência fica só na primeira ocorrência (ela é
 * única no banco).
 */
export async function writeEntrySeries(tx: Db, input: EntryInput) {
  const series = buildSeries({
    recurrenceType: input.recurrenceType,
    recurrenceFrequency: input.recurrenceFrequency,
    installments: input.installments,
    recurrenceMonths: input.recurrenceMonths,
    amount: input.amount,
    firstDate: input.firstDate,
  });
  const isCard = input.account.type === 'credit_card';
  const status = input.status ?? 'confirmed';
  const settle =
    !isCard && status === 'confirmed' && (input.settle ?? defaultSettle({ ...input, status }));
  if (settle && isFutureDay(input.firstDate)) {
    throw new BadRequestException(
      'Um lançamento com data futura ainda não foi pago: desmarque "já foi pago" ou use a data do pagamento.',
    );
  }

  const isInstallment = series.recurrenceType === 'parcelado';
  const purchaseDate = isInstallment
    ? isCard
      ? input.firstDate
      : (input.eventDate ?? input.firstDate)
    : null;
  const purchaseId = isInstallment ? series.rows[0].seriesId : null;
  if (isInstallment && purchaseId) {
    await tx.installmentPurchase.create({
      data: {
        id: purchaseId,
        userId: input.userId,
        accountId: input.account.id,
        categoryId: input.categoryId,
        type: input.type,
        description: input.description,
        purchaseDate: purchaseDate!,
        totalAmount: input.amount,
        installmentCount: series.rows.length,
      },
    });
  }

  const forecast =
    series.recurrenceType === 'fixo' ? (input.forecast ?? true) : (input.forecast ?? false);
  const base = {
    userId: input.userId,
    accountId: input.account.id,
    categoryId: input.categoryId,
    type: input.type,
    description: input.description,
    status,
    source: input.source,
    rawInput: input.rawInput ?? null,
    recurrenceType: series.recurrenceType,
    recurrenceFrequency: series.recurrenceFrequency,
    forecast,
    purchaseId,
  } satisfies Partial<Prisma.TransactionUncheckedCreateInput>;

  const created = [];
  for (const [index, row] of series.rows.entries()) {
    const eventDate =
      purchaseDate ??
      (series.recurrenceType === 'avulso' && !isCard
        ? (input.eventDate ?? row.transactionDate)
        : row.transactionDate);
    created.push(
      await tx.transaction.create({
        data: {
          ...base,
          ...row,
          eventDate,
          ...(index === 0 && input.idempotencyKey && { idempotencyKey: input.idempotencyKey }),
        },
        include: { category: true, account: true },
      }),
    );
  }

  if (settle) {
    const first = created[0];
    await recordSettlement(tx, {
      userId: input.userId,
      transactionId: first.id,
      accountId: input.account.id,
      amountCents: cents(first.amount),
      date: first.transactionDate,
      origin: input.settlementOrigin,
    });
  }

  return { rows: created, settled: settle, purchaseId };
}
