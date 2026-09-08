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
 * "Hoje" em America/Sao_Paulo, como `{ year, month (1-11 UTC-style... na
 * verdade 0-based para casar com Date), day }`. Necessário porque `new
 * Date()` cru reflete o fuso do servidor/UTC — entre 21h e 0h local o dia UTC
 * já virou o dia seguinte. Usado pelo cron de recorrência e por qualquer
 * cálculo de "vencido"/"dia do mês" que precise do dia-calendário correto.
 */
export function todaySaoPaulo(): { year: number; monthIndex: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), monthIndex: get('month') - 1, day: get('day') };
}

/** Dia-calendário puro, sem horário nem fuso — a unidade com que o app raciocina. */
export type CalendarDay = { year: number; monthIndex: number; day: number };

/** Soma `days` dias a um dia-calendário (opera em meio-dia UTC, independe de fuso). */
export function addDaysSaoPaulo(date: CalendarDay, days: number): CalendarDay {
  const d = new Date(Date.UTC(date.year, date.monthIndex, date.day, 12, 0, 0));
  d.setUTCDate(d.getUTCDate() + days);
  return { year: d.getUTCFullYear(), monthIndex: d.getUTCMonth(), day: d.getUTCDate() };
}

/** Subtrai `days` dias de um dia-calendário (opera em meio-dia UTC, independe de fuso). */
export function subtractDaysSaoPaulo(date: CalendarDay, days: number): CalendarDay {
  return addDaysSaoPaulo(date, -days);
}

/** Serializa um dia-calendário como `"YYYY-MM-DD"`. */
export function dateOnlyString(date: CalendarDay): string {
  return `${date.year}-${String(date.monthIndex + 1).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

/** Serializa a competência (`"YYYY-MM"`) de um dia-calendário. */
export function competenceString(date: CalendarDay): string {
  return `${date.year}-${String(date.monthIndex + 1).padStart(2, '0')}`;
}

/**
 * Converte uma coluna `@db.Date` do Prisma (meia-noite UTC) no dia-calendário
 * que ela representa. Ler os componentes em UTC é obrigatório: `getDate()` cru
 * devolveria o dia anterior em qualquer fuso negativo.
 */
export function calendarDayFromUtcDate(date: Date): CalendarDay {
  return { year: date.getUTCFullYear(), monthIndex: date.getUTCMonth(), day: date.getUTCDate() };
}

/** Ordena dois dias-calendário: negativo se `a` vem antes de `b`, 0 se iguais. */
export function compareCalendarDays(a: CalendarDay, b: CalendarDay): number {
  return Date.UTC(a.year, a.monthIndex, a.day, 12) - Date.UTC(b.year, b.monthIndex, b.day, 12);
}

/** O mais recente entre dois dias-calendário. */
export function maxCalendarDay(a: CalendarDay, b: CalendarDay): CalendarDay {
  return compareCalendarDays(a, b) >= 0 ? a : b;
}

/** Dias inteiros de `from` até `to` (negativo se `to` vem antes). */
export function daysBetweenCalendarDays(from: CalendarDay, to: CalendarDay): number {
  return Math.round(compareCalendarDays(to, from) / 86_400_000);
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
