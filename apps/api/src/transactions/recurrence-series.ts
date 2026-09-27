import { randomUUID } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { RecurrenceFrequency, RecurrenceType } from '@prisma/client';
import { addMonthsUtc } from '../common/date.util';
import { FREQUENCY_STEP_MONTHS } from './recurrence-frequency';

/** O que o lançamento informa sobre a própria recorrência. */
export interface SeriesInput {
  recurrenceType?: RecurrenceType;
  recurrenceFrequency?: RecurrenceFrequency;
  installments?: number;
  recurrenceMonths?: number;
  amount: number;
  firstDate: Date;
}

/** Uma ocorrência a gravar: o que muda de uma linha para a outra da série. */
export interface SeriesRow {
  amount: number;
  transactionDate: Date;
  seriesId: string | null;
  installmentNumber: number | null;
  installmentTotal: number | null;
}

export interface Series {
  recurrenceType: RecurrenceType;
  recurrenceFrequency: RecurrenceFrequency | null;
  rows: SeriesRow[];
}

/**
 * Monta as ocorrências de um lançamento: uma só no avulso, N no parcelado e no
 * fixo. Usado pelo formulário (`POST /transactions`) e pelo WhatsApp
 * (`/internal/transactions/from-ai`), para que os dois gerem a mesma série.
 *
 * Em "parcelado" o valor é o TOTAL da compra e é dividido; em "fixo" o valor é
 * o de cada ocorrência (uma mensalidade de R$ 200 por 12 meses são 12
 * lançamentos de R$ 200, não de R$ 16,67).
 */
export function buildSeries(input: SeriesInput): Series {
  const recurrenceType = input.recurrenceType ?? 'avulso';
  const recurrenceFrequency =
    recurrenceType === 'fixo' ? (input.recurrenceFrequency ?? 'monthly') : null;
  // Parcelas são sempre mensais; o fixo segue a frequência escolhida.
  const stepMonths = recurrenceFrequency ? FREQUENCY_STEP_MONTHS[recurrenceFrequency] : 1;

  let occurrences: number;
  if (recurrenceType === 'parcelado') {
    if (!input.installments || input.installments < 2 || input.installments > 72) {
      throw new BadRequestException('Número de parcelas inválido (mínimo 2, máximo 72)');
    }
    occurrences = input.installments;
  } else if (recurrenceType === 'fixo') {
    if (!input.recurrenceMonths || input.recurrenceMonths < 2 || input.recurrenceMonths > 120) {
      throw new BadRequestException('Quantidade de ocorrências inválida (mínimo 2, máximo 120)');
    }
    occurrences = input.recurrenceMonths;
  } else {
    occurrences = 1;
  }

  const seriesId = occurrences > 1 ? randomUUID() : null;
  const amountFor =
    recurrenceType === 'parcelado'
      ? installmentAmounts(input.amount, occurrences)
      : () => input.amount;

  const rows = Array.from({ length: occurrences }, (_, i) => ({
    amount: amountFor(i),
    transactionDate: i === 0 ? input.firstDate : addMonthsUtc(input.firstDate, i * stepMonths),
    seriesId,
    installmentNumber: seriesId ? i + 1 : null,
    installmentTotal: seriesId ? occurrences : null,
  }));

  return { recurrenceType, recurrenceFrequency, rows };
}

export function installmentAmounts(total: number, count: number): (index: number) => number {
  const totalCents = Math.round(total * 100);
  const baseCents = Math.floor(totalCents / count);
  const remainderCents = totalCents - baseCents * count;
  return (index) => (index === count - 1 ? baseCents + remainderCents : baseCents) / 100;
}
