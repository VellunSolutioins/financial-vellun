import { Injectable } from '@nestjs/common';
import { CreditCard, CreditCardInvoice, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { Db } from '../common/db';
import {
  CalendarDay,
  calendarDayFromUtcDate,
  compareCalendarDays,
  dateOnlyString,
  endOfDayUtc,
  parseDateOnly,
  todaySaoPaulo,
} from '../common/date.util';
import { reconcileCard } from './card-reconciliation';
import { cardNeedsSetup } from './card-setup';
import { CycleConfig, InvoiceAmounts, InvoiceSpan, cycleFor, toCents } from './invoice-cycle';

export type StoredSpan = InvoiceSpan & { id: string };

/**
 * Tipos que entram em fatura: compras, estornos e a posição inicial do cartão.
 * As pernas de pagamento (`transfer`) não: o pagamento aponta para a fatura
 * pelo `CardPayment`.
 */
export const INVOICE_ENTRY_TYPES = ['expense', 'refund', 'opening_debt', 'opening_credit'] as const;

/**
 * Posição inicial (docs/adrs/0018): gravada direto na fatura anterior ao
 * controle pelo `POST /credit-cards/:id/opening-position`. A sincronização não
 * a move — ela não tem data de compra para recalcular.
 */
export const OPENING_TYPES = ['opening_debt', 'opening_credit'] as const;

/** Tipos atribuídos a fatura pela data (ou pela cadeia da parcela). */
const ASSIGNABLE_TYPES = ['expense', 'refund'] as const;

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
  eventDate: Date;
  budgetDate: Date | null;
  seriesId: string | null;
  recurrenceType: string;
  installmentNumber: number | null;
  invoiceId: string | null;
  advancedAt: Date | null;
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
 * `syncTransactions` — dentro da mesma transação de banco, passando o `tx`. A
 * sincronização é idempotente: recalcula a fatura que cada lançamento deveria
 * ter e só grava o que mudou.
 */
@Injectable()
export class CardLedgerService {
  constructor(private prisma: PrismaService) {}

  /** Recalcula a fatura de cada lançamento informado (de cartão ou não). */
  async syncTransactions(ids: readonly string[], db: Db = this.prisma): Promise<void> {
    if (ids.length === 0) return;
    const rows = await db.transaction.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        type: true,
        status: true,
        transactionDate: true,
        eventDate: true,
        budgetDate: true,
        seriesId: true,
        recurrenceType: true,
        installmentNumber: true,
        invoiceId: true,
        advancedAt: true,
        account: { select: { userId: true, creditCard: true } },
      },
    });

    // Lançamento que saiu de um cartão (troca de conta) não tem fatura.
    const detached = rows.filter((r) => !r.account.creditCard && r.invoiceId).map((r) => r.id);
    if (detached.length) {
      await db.transaction.updateMany({
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
    for (const { card, userId, txs } of byCard.values()) {
      await this.syncCard(card, userId, txs, db);
    }
  }

  /** Recalcula todos os lançamentos de um cartão (usado na configuração). */
  async syncCardAccount(accountId: string, db: Db = this.prisma): Promise<void> {
    const ids = await db.transaction.findMany({
      where: { accountId },
      select: { id: true },
    });
    await this.syncTransactions(
      ids.map((t) => t.id),
      db,
    );
  }

  /**
   * Troca de fechamento/vencimento: só as faturas futuras (período começando
   * depois de hoje) são refeitas. A atual e as fechadas mantêm as datas.
   */
  async rebuildFutureInvoices(card: CreditCard): Promise<void> {
    const today = toDbDate(todaySaoPaulo());
    await this.prisma.$transaction(async (tx) => {
      // Fatura futura já paga (pagamento antecipado) fica como está: o
      // pagamento aponta para ela.
      const future = await tx.creditCardInvoice.findMany({
        where: { creditCardId: card.id, periodStart: { gt: today }, payments: { none: {} } },
        select: { id: true },
      });
      if (future.length === 0) return;
      const futureIds = future.map((f) => f.id);
      const affected = await tx.transaction.findMany({
        where: { invoiceId: { in: futureIds } },
        select: { id: true },
      });
      await tx.transaction.updateMany({
        where: { invoiceId: { in: futureIds } },
        data: { invoiceId: null },
      });
      await tx.creditCardInvoice.deleteMany({ where: { id: { in: futureIds } } });
      await this.syncTransactions(
        affected.map((t) => t.id),
        tx,
      );
    });
  }

  /**
   * Por que cada lançamento não pode mudar de valor, data, conta, tipo ou
   * status. Perna de pagamento ou de transferência só muda revertendo;
   * posição inicial só pela tela dela; cobrança em fatura fechada só se
   * corrige com estorno. Descrição e categoria continuam editáveis (não mexem
   * em valores).
   *
   * Pagamento não trava (docs/adrs/0021): a fatura aberta pode ser paga antes
   * do fechamento, inteira ou em parte, e as compras do mês seguem editáveis.
   * Os valores de fatura são derivados: se uma compra já paga muda ou sai, a
   * sobra do pagamento vira crédito para as próximas faturas.
   */
  async lockReasons(
    txs: readonly {
      id: string;
      invoiceId: string | null;
      cardPaymentId: string | null;
      accountTransferId?: string | null;
      type?: string;
    }[],
    db: Db = this.prisma,
  ): Promise<Map<string, string>> {
    const reasons = new Map<string, string>();
    const invoiceIds = [...new Set(txs.map((t) => t.invoiceId).filter(Boolean))] as string[];
    const invoices = invoiceIds.length
      ? await db.creditCardInvoice.findMany({
          where: { id: { in: invoiceIds } },
          select: { id: true, closingDate: true },
        })
      : [];
    const today = todaySaoPaulo();
    const byId = new Map(invoices.map((i) => [i.id, i]));
    for (const tx of txs) {
      if (tx.cardPaymentId) {
        reasons.set(
          tx.id,
          'Este lançamento faz parte de um pagamento de fatura. Para desfazer, reverta o pagamento no cartão.',
        );
        continue;
      }
      if (tx.accountTransferId) {
        reasons.set(
          tx.id,
          'Este lançamento faz parte de uma transferência entre contas. Para desfazer, reverta a transferência.',
        );
        continue;
      }
      if (tx.type && (OPENING_TYPES as readonly string[]).includes(tx.type)) {
        reasons.set(
          tx.id,
          'Esta é a posição inicial do cartão. Altere-a em "Posição inicial", na tela do cartão.',
        );
        continue;
      }
      const invoice = tx.invoiceId ? byId.get(tx.invoiceId) : undefined;
      if (!invoice) continue;
      if (compareCalendarDays(today, calendarDayFromUtcDate(invoice.closingDate)) >= 0) {
        reasons.set(
          tx.id,
          'Este lançamento está em uma fatura fechada. Valor, data, cartão e cancelamento não mudam mais: use estorno.',
        );
      }
    }
    return reasons;
  }

  /**
   * Para cada fatura dos cartões, a fração do cobrado que ainda falta pagar
   * (0 a 1), já com pagamentos, estornos e créditos de outras faturas. Uma
   * compra de R$ 100 numa fatura paga pela metade ainda deve R$ 50: é assim
   * que se reparte por compra ou por categoria o que falta de uma fatura.
   */
  async unpaidShareByInvoice(
    cardIds: readonly string[],
    db: Db = this.prisma,
  ): Promise<Map<string, number>> {
    const shares = new Map<string, number>();
    const amounts = await this.invoicesWithAmounts(cardIds, db);
    for (const invoices of amounts.values()) {
      for (const row of reconcileCard(invoices).invoices) {
        shares.set(
          row.invoice.span.id,
          row.debitCents > 0 ? row.remainingCents / row.debitCents : 0,
        );
      }
    }
    return shares;
  }

  /** Depois de excluir lançamentos de uma conta: some com faturas futuras vazias. */
  async pruneForAccount(accountId: string, db: Db = this.prisma): Promise<void> {
    const card = await db.creditCard.findUnique({
      where: { accountId },
      select: { id: true },
    });
    if (card) await this.pruneEmptyFutureInvoices(card.id, db);
  }

  /**
   * Faturas dos cartões com os valores de cada uma, da que vence primeiro
   * para a última.
   *
   * Só é **cobrança efetiva** o que tem data do fato até hoje: a compra feita,
   * inclusive todas as parcelas dela (a data do fato da parcela é a da compra).
   * Uma ocorrência futura de assinatura, ou uma compra cadastrada com data
   * futura, é **previsão** (`forecastCents`): aparece na fatura em que vai
   * cair, mas não é dívida nem consome limite (docs/adrs/0018).
   */
  async invoicesWithAmounts(
    cardIds: readonly string[],
    db: Db = this.prisma,
  ): Promise<Map<string, InvoiceAmounts<StoredSpan>[]>> {
    const result = new Map<string, InvoiceAmounts<StoredSpan>[]>();
    if (cardIds.length === 0) return result;
    const rows = await db.creditCardInvoice.findMany({
      where: { creditCardId: { in: [...cardIds] } },
      orderBy: [{ dueDate: 'asc' }, { closingDate: 'asc' }],
    });
    const invoiceIds = rows.map((r) => r.id);
    const endOfToday = endOfDayUtc(dateOnlyString(todaySaoPaulo()));
    const base = {
      invoiceId: { in: invoiceIds },
      status: 'confirmed' as const,
    };
    const [effective, forecast, payments] = invoiceIds.length
      ? await Promise.all([
          db.transaction.groupBy({
            by: ['invoiceId', 'type'],
            where: {
              ...base,
              type: { in: [...INVOICE_ENTRY_TYPES] },
              eventDate: { lte: endOfToday },
            },
            _sum: { amount: true },
          }),
          db.transaction.groupBy({
            by: ['invoiceId'],
            where: { ...base, type: 'expense', eventDate: { gt: endOfToday } },
            _sum: { amount: true },
          }),
          db.cardPayment.groupBy({
            by: ['invoiceId'],
            where: { invoiceId: { in: invoiceIds }, status: 'active' },
            _sum: { amount: true },
          }),
        ])
      : [[], [], []];
    const sumOf = (invoiceId: string, type: string) =>
      toCents(effective.find((e) => e.invoiceId === invoiceId && e.type === type)?._sum.amount);
    const forecastById = new Map(forecast.map((f) => [f.invoiceId, toCents(f._sum.amount)]));
    const paidById = new Map(payments.map((p) => [p.invoiceId, toCents(p._sum.amount)]));

    for (const row of rows) {
      const list = result.get(row.creditCardId) ?? [];
      list.push({
        span: toStoredSpan(row),
        chargesCents: sumOf(row.id, 'expense'),
        refundsCents: sumOf(row.id, 'refund'),
        paymentsCents: paidById.get(row.id) ?? 0,
        openingDebtCents: sumOf(row.id, 'opening_debt'),
        openingCreditCents: sumOf(row.id, 'opening_credit'),
        forecastCents: forecastById.get(row.id) ?? 0,
      });
      result.set(row.creditCardId, list);
    }
    return result;
  }

  private async syncCard(card: CreditCard, userId: string, all: LedgerTransaction[], db: Db) {
    // A posição inicial fica na fatura em que foi gravada.
    const txs = all.filter((tx) => !(OPENING_TYPES as readonly string[]).includes(tx.type));
    const { invoices: desired, postingDates } = cardNeedsSetup(card)
      ? {
          invoices: new Map(txs.map((tx) => [tx.id, null as string | null])),
          postingDates: new Map<string, Date>(),
        }
      : await this.assignInvoices(card as ConfiguredCard, userId, txs, db);

    const byTarget = new Map<string | null, string[]>();
    for (const tx of txs) {
      const target = desired.get(tx.id) ?? null;
      if (tx.invoiceId === target) continue;
      const list = byTarget.get(target) ?? [];
      list.push(tx.id);
      byTarget.set(target, list);
    }
    for (const [invoiceId, ids] of byTarget) {
      await db.transaction.updateMany({
        where: { id: { in: ids } },
        data: { invoiceId },
      });
    }

    // A parcela 2+ é cobrada quando a fatura dela abre (docs/adrs/0022): a
    // data passa a ser o primeiro dia da fatura. A data original (compra + n
    // meses) fica em `budgetDate`, que é o mês em que ela pesa nos gastos.
    for (const tx of txs) {
      const posting = postingDates.get(tx.id);
      if (!posting || posting.getTime() === tx.transactionDate.getTime()) continue;
      await db.transaction.update({
        where: { id: tx.id },
        data: { transactionDate: posting, budgetDate: tx.budgetDate ?? tx.transactionDate },
      });
    }

    await this.pruneEmptyFutureInvoices(card.id, db);
  }

  /**
   * `invoices`: `txId → invoiceId` (ou `null`), criando as faturas que
   * faltarem. `postingDates`: a data em que cada parcela 2+ entra na fatura —
   * o primeiro dia dela —, só para faturas ainda não fechadas (as fechadas não
   * mudam mais).
   */
  private async assignInvoices(
    card: ConfiguredCard,
    userId: string,
    txs: LedgerTransaction[],
    db: Db,
  ): Promise<{ invoices: Map<string, string | null>; postingDates: Map<string, Date> }> {
    const config: CycleConfig = { closingDay: card.closingDay, dueDay: card.dueDay };
    const trackingStart = calendarDayFromUtcDate(card.invoiceTrackingStart);
    const stored = (await db.creditCardInvoice.findMany({ where: { creditCardId: card.id } })).map(
      toStoredSpan,
    );
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

    const chains = new Map<string, InvoiceSpan[]>();
    // Parcelas atribuídas pelo ciclo da compra + (n − 1): as que são datadas
    // na abertura da fatura.
    const byCycle = new Set<string>();

    const assigned = new Map<string, InvoiceSpan | null>();
    for (const tx of txs) {
      const own = calendarDayFromUtcDate(tx.transactionDate);
      const isEntry =
        tx.status === 'confirmed' && (ASSIGNABLE_TYPES as readonly string[]).includes(tx.type);
      if (!isEntry || compareCalendarDays(own, trackingStart) < 0) {
        assigned.set(tx.id, null);
        continue;
      }

      // Parcela i vai para o ciclo da compra + (i − 1), sem depender do clamp
      // da data da parcela. A data da compra é a data do fato da parcela (a
      // mesma em todas). Série comprada antes do início do controle segue a
      // data de cada parcela. Parcela adiantada também: foi trazida para a
      // fatura aberta na data do adiantamento.
      const purchase =
        tx.recurrenceType === 'parcelado' && tx.seriesId
          ? calendarDayFromUtcDate(tx.eventDate)
          : undefined;
      const n = tx.installmentNumber ?? 1;
      if (
        tx.recurrenceType === 'parcelado' &&
        !tx.advancedAt &&
        tx.seriesId &&
        n > 1 &&
        purchase &&
        compareCalendarDays(purchase, trackingStart) >= 0
      ) {
        const chain = chains.get(tx.seriesId) ?? [resolve(purchase)];
        while (chain.length < n) chain.push(resolve(chain[chain.length - 1].closingDate));
        chains.set(tx.seriesId, chain);
        assigned.set(tx.id, chain[n - 1]);
        byCycle.add(tx.id);
      } else {
        assigned.set(tx.id, resolve(own));
      }
    }

    // Persiste as faturas novas e as estendidas.
    const idOf = new Map<InvoiceSpan, string>(stored.map((s) => [s, s.id]));
    for (const span of spans) {
      if (idOf.has(span)) continue;
      const row = await db.creditCardInvoice.upsert({
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
      await db.creditCardInvoice.update({
        where: { id: idOf.get(span)! },
        data: { periodStart: toDbDate(span.periodStart) },
      });
    }

    // Só depois de todas as atribuições: o início de uma fatura pode ter sido
    // estendido no caminho.
    const today = todaySaoPaulo();
    const postingDates = new Map<string, Date>();
    for (const txId of byCycle) {
      const span = assigned.get(txId);
      if (span && compareCalendarDays(span.closingDate, today) > 0) {
        postingDates.set(txId, toDbDate(span.periodStart));
      }
    }

    return {
      invoices: new Map(
        [...assigned].map(([txId, span]) => [txId, span ? (idOf.get(span) ?? null) : null]),
      ),
      postingDates,
    };
  }

  /** Fatura futura sem lançamento não tem por que existir. */
  private async pruneEmptyFutureInvoices(creditCardId: string, db: Db) {
    await db.creditCardInvoice.deleteMany({
      where: {
        creditCardId,
        periodStart: { gt: toDbDate(todaySaoPaulo()) },
        transactions: { none: {} },
        payments: { none: {} },
      } satisfies Prisma.CreditCardInvoiceWhereInput,
    });
  }
}
