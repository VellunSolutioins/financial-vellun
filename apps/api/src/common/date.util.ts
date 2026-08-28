/**
 * Converte uma data **sem horário** (ex.: `"2026-06-01"`) no instante
 * correspondente a **meio-dia UTC** daquele dia-calendário.
 *
 * Por quê: `new Date("2026-06-01")` é interpretado como meia-noite **UTC**
 * (`2026-06-01T00:00:00Z`); em fusos negativos (ex.: America/Sao_Paulo, UTC-3)
 * isso vira `2026-05-31 21:00` e o lançamento "volta" um dia ao ser exibido.
 * Fixando ao meio-dia UTC, o dia-calendário se mantém o mesmo em qualquer fuso
 * de −11h a +11h.
 *
 * Entradas que já contenham horário (ISO completo) são preservadas.
 */
export function parseDateOnly(input: string | Date): Date {
  if (input instanceof Date) return input;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (match) {
    const [, year, month, day] = match;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0));
  }

  return new Date(input);
}

/** Início do dia (00:00:00.000 UTC) — limite inferior inclusivo de período. */
export function startOfDayUtc(input: string): Date {
  const [y, m, d] = input.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0));
}

/**
 * Fim do dia (23:59:59.999 UTC) — limite superior inclusivo. Necessário porque
 * os lançamentos são gravados ao meio-dia UTC (ver {@link parseDateOnly}); um
 * `lte` em meia-noite deixaria o último dia de fora.
 */
export function endOfDayUtc(input: string): Date {
  const [y, m, d] = input.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1, 23, 59, 59, 999));
}

/** Primeiro dia do mês (00:00 UTC). */
export function startOfMonthUtc(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
}

/** Último dia do mês (23:59:59.999 UTC). */
export function endOfMonthUtc(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999));
}

/**
 * Soma `months` meses a uma data (UTC), travando o dia no último dia do mês
 * de destino quando ele não existir (ex.: 31/jan + 1 mês → 28 ou 29/fev, em
 * vez de "vazar" para março, que é o comportamento padrão do `Date`).
 */
export function addMonthsUtc(date: Date, months: number): Date {
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDayOfTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  target.setUTCHours(
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  );
  return target;
}
