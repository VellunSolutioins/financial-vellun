import { endOfMonthUtc, startOfMonthUtc } from '../common/date.util';
import { DashboardService, MonthlyTotalRow, buildMonthlySeries } from './dashboard.service';

/**
 * Critério de aceite do plano de performance (P2): *`getMonthlyComparison` com
 * 1 query em vez de 24, com o mesmo resultado*.
 *
 * "Mesmo resultado" só significa alguma coisa comparado com a versão antiga, e
 * é isso que este arquivo faz: a implementação anterior está reproduzida em
 * `comparativoMensalAntigo` e roda sobre o mesmo conjunto de lançamentos que
 * alimenta o dublê do Postgres. Se a agregação nova divergir em qualquer mês —
 * borda de mês, mês vazio, janela de 12 meses cruzando o ano —, a comparação
 * acusa.
 */

type Lancamento = { date: Date; type: 'income' | 'expense'; amount: number };

/** Meio-dia UTC, como `parseDateOnly` grava. */
function dia(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

/**
 * A versão anterior, literal: duas agregações por mês, 12 meses, em série.
 * Mantida aqui — e só aqui — como referência da comparação.
 */
function comparativoMensalAntigo(dados: Lancamento[], now: Date, months: number) {
  const result: { month: string; income: number; expense: number }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const ref = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year = ref.getFullYear();
    const monthIndex = ref.getMonth();
    const start = startOfMonthUtc(year, monthIndex);
    const end = endOfMonthUtc(year, monthIndex);

    const somar = (type: 'income' | 'expense') =>
      dados
        .filter((t) => t.type === type && t.date >= start && t.date <= end)
        .reduce((soma, t) => soma + t.amount, 0);

    result.push({
      month: `${year}-${String(monthIndex + 1).padStart(2, '0')}`,
      income: somar('income'),
      expense: somar('expense'),
    });
  }
  return result;
}

/**
 * Dublê do que o Postgres devolve para o `GROUP BY date_trunc('month', ...)`:
 * uma linha por (mês, tipo) **só onde houve lançamento**, com o total em texto
 * (é assim que `numeric::text` chega).
 */
function agregarComoPostgres(dados: Lancamento[], first: Date, last: Date): MonthlyTotalRow[] {
  const totais = new Map<string, number>();
  for (const t of dados) {
    if (t.date < first || t.date > last) continue;
    const chave = `${t.date.toISOString().slice(0, 7)}|${t.type}`;
    totais.set(chave, (totais.get(chave) ?? 0) + t.amount);
  }
  return [...totais.entries()].map(([chave, total]) => {
    const [month, type] = chave.split('|');
    return { month, type: type as 'income' | 'expense', total: total.toFixed(2) };
  });
}

function servicoCom(dados: Lancamento[], now: Date) {
  const queryRaw = jest.fn(async (_strings: unknown, ...params: unknown[]) => {
    // Os dois últimos parâmetros são as bordas da janela ('YYYY-MM-DD').
    const [firstIso, lastIso] = params.slice(-2) as string[];
    return agregarComoPostgres(dados, dia(`${firstIso}`), dia(`${lastIso}`));
  });
  const aggregate = jest.fn();
  const prisma = { $queryRaw: queryRaw, transaction: { aggregate } } as any;
  const service = new DashboardService(prisma);
  const rodar = (months: number) =>
    (service as any).getMonthlyComparison('user-1', months) as Promise<
      { month: string; income: number; expense: number }[]
    >;
  return { rodar, queryRaw, aggregate, now };
}

describe('comparativo mensal do dashboard', () => {
  const agora = new Date(2026, 8, 22); // 22/09/2026, hora local

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(agora);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('dá o mesmo resultado da versão com 24 queries', async () => {
    const dados: Lancamento[] = [
      // Primeiro e último dia do mês: é onde um erro de borda apareceria.
      { date: dia('2026-09-01'), type: 'income', amount: 1500 },
      { date: dia('2026-09-30'), type: 'expense', amount: 240.5 },
      { date: dia('2026-09-15'), type: 'expense', amount: 59.9 },
      // Mês anterior, e um mês do ano passado (a janela de 12 meses cruza o ano).
      { date: dia('2026-08-10'), type: 'income', amount: 8000 },
      { date: dia('2025-10-31'), type: 'expense', amount: 310 },
      // Fora da janela: não pode entrar em mês nenhum.
      { date: dia('2025-09-30'), type: 'income', amount: 99999 },
      // Tipo que a consulta não considera.
      { date: dia('2026-09-05'), type: 'income', amount: 12 },
    ];

    const { rodar } = servicoCom(dados, agora);

    expect(await rodar(12)).toEqual(comparativoMensalAntigo(dados, agora, 12));
  });

  it('faz uma query, não duas por mês', async () => {
    const { rodar, queryRaw, aggregate } = servicoCom([], agora);

    await rodar(12);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('meses sem lançamento continuam na série, com zero', async () => {
    // O banco não devolve linha para mês vazio. Se a grade não fosse montada
    // aqui, o gráfico perderia meses e as barras "andariam" no eixo.
    const { rodar } = servicoCom([{ date: dia('2026-09-03'), type: 'income', amount: 10 }], agora);

    const serie = await rodar(12);

    expect(serie).toHaveLength(12);
    expect(serie.map((m) => m.month)).toEqual(
      comparativoMensalAntigo([], agora, 12).map((m) => m.month),
    );
    expect(serie[11]).toEqual({ month: '2026-09', income: 10, expense: 0 });
    expect(serie[0]).toEqual({ month: '2025-10', income: 0, expense: 0 });
  });
});

describe('buildMonthlySeries', () => {
  const agora = new Date(2026, 8, 22);

  it('ignora linha fora da janela em vez de criar um mês no meio do gráfico', () => {
    const serie = buildMonthlySeries(
      [
        { month: '2026-09', type: 'income', total: '100' },
        { month: '1999-01', type: 'expense', total: '7' },
      ],
      agora,
      3,
    );

    expect(serie.map((m) => m.month)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(serie[2].income).toBe(100);
  });

  it('total nulo vira zero', () => {
    const serie = buildMonthlySeries(
      [{ month: '2026-09', type: 'expense', total: null }],
      agora,
      1,
    );

    expect(serie).toEqual([{ month: '2026-09', income: 0, expense: 0 }]);
  });
});
