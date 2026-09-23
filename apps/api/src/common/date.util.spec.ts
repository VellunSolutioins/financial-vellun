import {
  addDaysSaoPaulo,
  calendarDayFromUtcDate,
  compareCalendarDays,
  competenceString,
  dateOnlyString,
  daysBetweenCalendarDays,
  maxCalendarDay,
  subtractDaysSaoPaulo,
} from './date.util';

describe('helpers de dia-calendário', () => {
  const day = (year: number, monthIndex: number, d: number) => ({ year, monthIndex, day: d });

  it('soma e subtrai dias atravessando a virada de mês e de ano', () => {
    expect(addDaysSaoPaulo(day(2026, 0, 31), 1)).toEqual(day(2026, 1, 1));
    expect(addDaysSaoPaulo(day(2026, 11, 31), 1)).toEqual(day(2027, 0, 1));
    expect(subtractDaysSaoPaulo(day(2026, 2, 1), 1)).toEqual(day(2026, 1, 28));
  });

  it('serializa dia e competência com zero à esquerda', () => {
    expect(dateOnlyString(day(2026, 8, 5))).toBe('2026-09-05');
    expect(competenceString(day(2026, 0, 5))).toBe('2026-01');
  });

  it('lê uma coluna @db.Date (meia-noite UTC) sem voltar um dia', () => {
    // O dia 01/09 gravado como DATE chega como 2026-09-01T00:00:00Z; ler os
    // componentes em fuso local devolveria 31/08 em qualquer fuso negativo.
    expect(calendarDayFromUtcDate(new Date('2026-09-01T00:00:00.000Z'))).toEqual(day(2026, 8, 1));
  });

  it('ordena, escolhe o maior e mede a distância em dias', () => {
    expect(compareCalendarDays(day(2026, 8, 1), day(2026, 8, 2))).toBeLessThan(0);
    expect(compareCalendarDays(day(2026, 8, 2), day(2026, 8, 2))).toBe(0);
    expect(maxCalendarDay(day(2026, 8, 1), day(2026, 8, 2))).toEqual(day(2026, 8, 2));
    expect(daysBetweenCalendarDays(day(2026, 8, 1), day(2026, 8, 8))).toBe(7);
    expect(daysBetweenCalendarDays(day(2026, 8, 8), day(2026, 8, 1))).toBe(-7);
  });

  it('atravessa o horário de verão sem perder ou ganhar um dia', () => {
    // Opera em meio-dia UTC justamente para não depender de offset.
    expect(daysBetweenCalendarDays(day(2026, 9, 15), day(2026, 10, 15))).toBe(31);
  });
});
