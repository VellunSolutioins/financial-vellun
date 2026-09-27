import { installmentAmounts } from './transactions.service';

describe('installmentAmounts', () => {
  const split = (total: number, count: number) =>
    Array.from({ length: count }, (_, i) => installmentAmounts(total, count)(i));

  const sum = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;

  it('divide um total exato em parcelas iguais', () => {
    expect(split(1200, 12)).toEqual(Array(12).fill(100));
  });

  it('joga a sobra de centavos na última parcela, sem perder nem criar dinheiro', () => {
    const parcels = split(100, 3);
    expect(parcels.slice(0, 2)).toEqual([33.33, 33.33]);
    expect(parcels[2]).toBe(33.34);
    expect(sum(parcels)).toBe(100);
  });

  it('fecha o total exato em divisões feias', () => {
    for (const [total, count] of [
      [1000, 7],
      [49.9, 6],
      [0.05, 4],
      [12345.67, 11],
    ] as const) {
      expect(sum(split(total, count))).toBe(total);
    }
  });

  it('não devolve parcela negativa quando o total é menor que o número de parcelas', () => {
    const parcels = split(0.02, 5);
    expect(parcels.every((p) => p >= 0)).toBe(true);
    expect(sum(parcels)).toBe(0.02);
  });
});
