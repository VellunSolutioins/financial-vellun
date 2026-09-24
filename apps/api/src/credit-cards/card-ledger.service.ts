import { Injectable } from '@nestjs/common';
import { CreditCard, CreditCardInvoice, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  CalendarDay,
  calendarDayFromUtcDate,
  compareCalendarDays,
  dateOnlyString,
  parseDateOnly,
  todaySaoPaulo,
} from '../common/date.util';
import { cardNeedsSetup } from './card-setup';
import { CycleConfig, InvoiceAmounts, InvoiceSpan, cycleFor, toCents } from './invoice-cycle';

export type StoredSpan = InvoiceSpan & { id: string };

/** Tipos que entram em fatura: compras (e, na fase 4, estornos). */
export const INVOICE_ENTRY_TYPES = ['expense'] as const;

export function toStoredSpan(row: CreditCardInvoice): StoredSpan {
  return {
    id: row.id,
    referenceMonth: row.referenceMonth,
    periodStart: calendarDayFromUtcDate(row.periodStart),
    closingDate: calendarDayFromUtcDate(row.closingDate),
    dueDate: calendarDayFromUtcDate(row.dueDate),
  };
}

export function toDbDate(day: CalendarDay): Date {
  return parseDateOnly(dateOnlyString(day));
}

type LedgerTransaction = {
  id: string;
  type: string;
  status: string;
  transactionDate: Date;
  seriesId: string | null;
  recurrenceType: string;
  installmentNumber: number | null;
  invoiceId: string | null;
};

type ConfiguredCard = CreditCard & {
  closingDay: number;
  dueDay: number;
  invoiceTrackingStart: Date;
};

/**
 * Atribuição de lançamentos a faturas e leitura dos valores por fatura.
 *
 * Toda escrita que cria, muda ou cancela um lançamento de cartão chama
 * `syncTransactions` depois de gravar. A sincronização é idempotente: recalcula
 * a fatura que cada lançamento deveria ter e só grava o que mudou.
 */
@Injectable()
export class CardLedgerService {
  constructor(private prisma: PrismaService) {}

  /** Recalcula a fatura de cada lançamento informado (de cartão ou não). */
  async syncTransactions(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const rows = await this.prisma.transaction.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        type: true,
        status: true,
        transactionDate: true,
        seriesId: true,
        recurrenceType: true,
        installmentNumber: true,
        invoiceId: true,
        account: { select: { userId: true, creditCard: true } },
      },
    });

    // Lançamento que saiu de um cartão (troca de conta) não tem fatura.
    const detached = rows.filter((r) => !r.account.creditCard && r.invoiceId).map((r) => r.id);
    if (detached.length) {
      await this.prisma.transaction.updateMany({
        where: { id: { in: detached } },
        data: { invoiceId: null },
      });
    }

    const byCard = new Map<
      string,
      { card: CreditCard; userId: string; txs: LedgerTransaction[] }
    >();
    for (const { account, ...tx } of rows) {
      if (!account.creditCard) continue;
      const entry = byCard.get(account.creditCard.id) ?? {
        card: account.creditCard,
        userId: account.userId,
        txs: [],
      };
      entry.txs.push(tx);
      byCard.set(account.creditCard.id, entry);
    }
    for (const { card, userId, txs } of byCard.values()) await this.syncCard(card, userId, txs);
  }

  /** Recalcula todos os lançamentos de um cartão (usado na configuração). */
  async syncCardAccount(accountId: string): Promise<void> {
    const ids = await this.prisma.transaction.findMany({
      where: { accountId },
      select: { id: true },
    });
    await this.syncTransactions(ids.map((t) => t.id));
  }

  /**
   * Troca de fechamento/vencimento: só as faturas futuras (período começando
   * depois de hoje) são refeitas. A atual e as fechadas mantêm as datas.
   */
  async rebuildFutureInvoices(card: CreditCard): Promise<void> {
    const today = toDbDate(todaySaoPaulo());
    const future = await this.prisma.creditCardInvoice.findMany({
      where: { creditCardId: card.id, periodStart: { gt: today } },
      select: { id: true },
    });
    if (future.length === 0) return;
    const futureIds = future.map((f) => f.id);
    const affected = await this.prisma.transaction.findMany({
      where: { invoiceId: { in: futureIds } },
      select: { id: true },
    });
    await this.prisma.$transaction([
      this.prisma.transaction.updateMany({
        where: { invoiceId: { in: futureIds } },
        data: { invoiceId: null },
      }),
      this.prisma.creditCardInvoice.deleteMany({ where: { id: { in: futureIds } } }),
    ]);
    await this.syncTransactions(affected.map((t) => t.id));
  }

  /** Depois de excluir lançamentos de uma conta: some com faturas futuras vazias. */
  async pruneForAccount(accountId: string): Promise<void> {
    const card = await this.prisma.creditCard.findUnique({
      where: { accountId },
      select: { id: true },
    });
    if (card) await this.pruneEmptyFutureInvoices(card.id);
  }

  /** Faturas dos cartões com os valores de cada uma. */
  async invoicesWithAmounts(
    cardIds: readonly string[],
  ): Promise<Map<string, InvoiceAmounts<StoredSpan>[]>> {
    const result = new Map<string, InvoiceAmounts<StoredSpan>[]>();
    if (cardIds.length === 0) return result;
    const rows = await this.prisma.creditCardInvoice.findMany({
      where: { creditCardId: { in: [...cardIds] } },
      orderBy: { closingDate: 'asc' },
    });
    const invoiceIds = rows.map((r) => r.id);
    const charges = invoiceIds.length
      ? await this.prisma.transaction.groupBy({
          by: ['invoiceId'],
          where: { invoiceId: { in: invoiceIds }, status: 'confirmed', type: 'expense' },
          _sum: { amount: true },
        })
      : [];
    const chargesById = new Map(charges.map((c) => [c.invoiceId, toCents(c._sum.amount)]));

    for (const row of rows) {
      const list = result.get(row.creditCardId) ?? [];
      list.push({
        span: toStoredSpan(row),
        chargesCents: chargesById.get(row.id) ?? 0,
        refundsCents: 0,
        paymentsCents: 0,
      });
      result.set(row.creditCardId, list);
    }
    return result;
  }

  private async syncCard(card: CreditCard, userId: string, txs: LedgerTransaction[]) {
    const desired = cardNeedsSetup(card)
      ? new Map(txs.map((tx) => [tx.id, null as string | null]))
      : await this.assignInvoices(card as ConfiguredCard, userId, txs);

    const byTarget = new Map<string | null, string[]>();
    for (const tx of txs) {
      const target = desired.get(tx.id) ?? null;
      if (tx.invoiceId === target) continue;
      const list = byTarget.get(target) ?? [];
      list.push(tx.id);
      byTarget.set(target, list);
    }
    for (const [invoiceId, ids] of byTarget) {
      await this.prisma.transaction.updateMany({
        where: { id: { in: ids } },
        data: { invoiceId },
      });
    }

    await this.pruneEmptyFutureInvoices(card.id);
  }

  /** `txId → invoiceId` (ou `null`), criando as faturas que faltarem. */
  private async assignInvoices(
    card: ConfiguredCard,
    userId: string,
    txs: LedgerTransaction[],
  ): Promise<Map<string, string | null>> {
    const config: CycleConfig = { closingDay: card.closingDay, dueDay: card.dueDay };
    const trackingStart = calendarDayFromUtcDate(card.invoiceTrackingStart);
    const stored = (
      await this.prisma.creditCardInvoice.findMany({ where: { creditCardId: card.id } })
    ).map(toStoredSpan);
    const spans: InvoiceSpan[] = [...stored];
    const extended = new Set<InvoiceSpan>();

    const resolve = (date: CalendarDay): InvoiceSpan => {
      const result = cycleFor(date, config, spans);
      if (result.isNew) spans.push(result.span);
      if (result.extendPeriodStartTo) {
        result.span.periodStart = result.extendPeriodStartTo;
        extended.add(result.span);
      }
      return result.span;
    };

    // Data da compra de cada série parcelada = data da parcela 1.
    const seriesIds = [
      ...new Set(
        txs.filter((t) => t.recurrenceType === 'parcelado' && t.seriesId).map((t) => t.seriesId!),
      ),
    ];
    const firsts = seriesIds.length
      ? await this.prisma.transaction.findMany({
          where: { seriesId: { in: seriesIds }, installmentNumber: 1 },
          select: { seriesId: true, transactionDate: true },
        })
      : [];
    const purchaseDate = new Map(
      firsts.map((f) => [f.seriesId!, calendarDayFromUtcDate(f.transactionDate)]),
    );
    const chains = new Map<string, InvoiceSpan[]>();

    const assigned = new Map<string, InvoiceSpan | null>();
    for (const tx of txs) {
      const own = calendarDayFromUtcDate(tx.transactionDate);
      const isEntry =
        tx.status === 'confirmed' && (INVOICE_ENTRY_TYPES as readonly string[]).includes(tx.type);
      if (!isEntry || compareCalendarDays(own, trackingStart) < 0) {
        assigned.set(tx.id, null);
        continue;
      }

      // Parcela i vai para o ciclo da compra + (i − 1), sem depender do clamp
      // da data da parcela. Série comprada antes do início do controle segue a
      // data de cada parcela.
      const purchase = tx.seriesId ? purchaseDate.get(tx.seriesId) : undefined;
      const n = tx.installmentNumber ?? 1;
      if (
        tx.recurrenceType === 'parcelado' &&
        tx.seriesId &&
        n > 1 &&
        purchase &&
        compareCalendarDays(purchase, trackingStart) >= 0
      ) {
        const chain = chains.get(tx.seriesId) ?? [resolve(purchase)];
        while (chain.length < n) chain.push(resolve(chain[chain.length - 1].closingDate));
        chains.set(tx.seriesId, chain);
        assigned.set(tx.id, chain[n - 1]);
      } else {
        assigned.set(tx.id, resolve(own));
      }
    }

    // Persiste as faturas novas e as estendidas.
    const idOf = new Map<InvoiceSpan, string>(stored.map((s) => [s, s.id]));
    for (const span of spans) {
      if (idOf.has(span)) continue;
      const row = await this.prisma.creditCardInvoice.upsert({
        where: {
          creditCardId_referenceMonth: {
            creditCardId: card.id,
            referenceMonth: span.referenceMonth,
          },
        },
        create: {
          userId,
          creditCardId: card.id,
          referenceMonth: span.referenceMonth,
          periodStart: toDbDate(span.periodStart),
          closingDate: toDbDate(span.closingDate),
          dueDate: toDbDate(span.dueDate),
        },
        update: {},
      });
      idOf.set(span, row.id);
    }
    for (const span of extended) {
      await this.prisma.creditCardInvoice.update({
        where: { id: idOf.get(span)! },
        data: { periodStart: toDbDate(span.periodStart) },
      });
    }

    return new Map(
      [...assigned].map(([txId, span]) => [txId, span ? (idOf.get(span) ?? null) : null]),
    );
  }

  /** Fatura futura sem lançamento não tem por que existir. */
  private async pruneEmptyFutureInvoices(creditCardId: string) {
    await this.prisma.creditCardInvoice.deleteMany({
      where: {
        creditCardId,
        periodStart: { gt: toDbDate(todaySaoPaulo()) },
        transactions: { none: {} },
      } satisfies Prisma.CreditCardInvoiceWhereInput,
    });
  }
}
