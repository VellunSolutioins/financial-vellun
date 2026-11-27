/**
 * Massa de dados fictícios para testes de usabilidade no ambiente local.
 *
 * Cria, do zero, uma pessoa física com 18 meses de histórico e alguns meses à
 * frente, num cenário de finanças pessoais comum: salário de R$ 8.000 que cai
 * uma vez por mês, aluguel e contas da casa no débito, um cartão com mercado,
 * combustível, streaming e gastos do dia a dia (fatura paga inteira todo mês),
 * duas compras parceladas e cerca de R$ 50 mil num CDB que recebe aporte
 * mensal de R$ 2.000. O orçamento fecha: sobra pouco mais de R$ 1 mil por mês.
 *
 * Tudo passa pelos serviços reais da API (os mesmos dos testes de integração),
 * então faturas, parcelas, liquidações e saldos seguem as regras do domínio
 * (docs/adrs/0018).
 *
 *   pnpm --filter @financial-vellun/api db:seed:usability
 *
 * Cada execução apaga e recria **só** a usuária de teste (e-mail em
 * `@zeloo.test`). Para apenas remover:
 *
 *   USABILITY_CLEANUP=true pnpm --filter @financial-vellun/api db:seed:usability
 *
 * Os dados saem sempre iguais (semente fixa). Nome, telefone e e-mail são
 * inventados. Precisa do seed padrão antes (`db:seed`): categorias padrão e o
 * plano `vellun-local-dev`.
 */

import { randomUUID } from 'crypto';
import { AccountType, ProfileType, SubscriptionStatus, type Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

import { PrismaService } from '../src/prisma/prisma.service';
import { AccountsService } from '../src/accounts/accounts.service';
import { TransactionsService } from '../src/transactions/transactions.service';
import { SettlementsService } from '../src/transactions/settlements.service';
import { CreditCardsService } from '../src/credit-cards/credit-cards.service';
import { CardPaymentsService } from '../src/credit-cards/card-payments.service';
import { TransfersService } from '../src/transfers/transfers.service';
import { SpendingGoalsService } from '../src/spending-goals/spending-goals.service';
import { RemindersService } from '../src/reminders/reminders.service';
import { NotesService } from '../src/notes/notes.service';
import { AgendaEventsService } from '../src/agenda-events/agenda-events.service';
import { dateOnlyString, todaySaoPaulo } from '../src/common/date.util';

/** Senha da usuária de teste. Só existe no ambiente local. */
const TEST_PASSWORD = 'Teste@1234';

const TEST_USER = {
  email: 'ana.souza@zeloo.test',
  name: 'Ana Souza (teste)',
  phone: '(41) 90000-1001',
  whatsapp: '+5541900001001',
  cpf: '00000001001',
} as const;

/** Usuários de versões anteriores desta massa: removidos a cada execução. */
const LEGACY_EMAILS = ['financeiro@padariabomgrao.test'];

/**
 * Orçamento do mês. Gastos médios no cartão (~R$ 2.300 com parcelas) e na
 * conta (~R$ 2.550) somam ~R$ 4.850; com o aporte de R$ 2.000, sobra pouco
 * mais de R$ 1 mil por mês na conta.
 */
const BUDGET = {
  salary: 8000,
  rent: 2200,
  monthlyInvestment: 2000,
  /** Rendimento líquido aproximado de um CDB de liquidez diária. */
  cdbMonthlyYield: 0.008,
  checkingStart: 2800,
  /** Chega a ~R$ 50 mil hoje, com os aportes e o rendimento do período. */
  cdbStart: 10000,
};

/** Meses de histórico, contando o atual. */
const HISTORY_MONTHS = 18;
/** Meses à frente das recorrências (previsões). */
const FUTURE_MONTHS = 6;

// ---------------------------------------------------------------------------
// Segurança: só banco local.
// ---------------------------------------------------------------------------

function requireLocalDatabase(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('A massa de usabilidade não roda com NODE_ENV=production.');
  }
  const url = process.env.DATABASE_URL ?? '';
  const host = url.split('@').pop() ?? '';
  if (!/localhost|127\.0\.0\.1|::1|host\.docker\.internal/.test(host)) {
    throw new Error('DATABASE_URL não aponta para um banco local: nada foi feito.');
  }
}

// ---------------------------------------------------------------------------
// Aleatório com semente e datas.
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRandom(seed: number) {
  const next = mulberry32(seed);
  const int = (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min;
  const money = (min: number, max: number) => Math.round((min + next() * (max - min)) * 100) / 100;
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
  const chance = (p: number) => next() < p;
  return { next, int, money, pick, chance };
}

type Ymd = { y: number; m: number }; // m: 1..12

const TODAY = dateOnlyString(todaySaoPaulo());
const [TY, TM] = TODAY.split('-').map(Number);

function daysIn({ y, m }: Ymd) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addMonths({ y, m }: Ymd, n: number): Ymd {
  const index = y * 12 + (m - 1) + n;
  return { y: Math.floor(index / 12), m: (index % 12) + 1 };
}

/** `YYYY-MM-DD` no mês, com o dia limitado ao fim do mês. */
function day(month: Ymd, d: number) {
  const dd = Math.min(Math.max(1, d), daysIn(month));
  return `${month.y}-${String(month.m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

function addDays(date: string, n: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const isPast = (date: string) => date < TODAY;
const isPastOrToday = (date: string) => date <= TODAY;

const START: Ymd = addMonths({ y: TY, m: TM }, -(HISTORY_MONTHS - 1));
const MONTHS: Ymd[] = Array.from({ length: HISTORY_MONTHS }, (_, i) => addMonths(START, i));

// ---------------------------------------------------------------------------
// Serviços (montados como nos testes de integração: test/financial-test-env.ts).
// ---------------------------------------------------------------------------

const prisma = new PrismaService();
const accounts = new AccountsService(prisma);
const transactions = new TransactionsService(prisma, accounts);
const settlements = new SettlementsService(prisma, accounts);
const cards = new CreditCardsService(prisma);
const payments = new CardPaymentsService(prisma, accounts);
const transfers = new TransfersService(prisma, accounts);
const goals = new SpendingGoalsService(prisma);
const reminders = new RemindersService(prisma);
const notes = new NotesService(prisma);
const agenda = new AgendaEventsService(prisma);

const stats = { created: 0, failed: 0 };

/** Roda uma criação; um erro de regra numa linha não derruba a carga inteira. */
async function attempt<T>(label: string, run: () => Promise<T>): Promise<T | null> {
  try {
    const result = await run();
    stats.created++;
    return result;
  } catch (error) {
    stats.failed++;
    if (stats.failed <= 15) console.warn(`  ! ${label}: ${(error as Error).message}`);
    return null;
  }
}

type CreateTx = Parameters<TransactionsService['create']>[1];

async function tx(userId: string, data: CreateTx) {
  return attempt(`${data.description} ${data.transactionDate}`, () =>
    transactions.create(userId, { idempotencyKey: randomUUID(), ...data }),
  );
}

/**
 * Lançamento fixo (previsão) com as ocorrências passadas já pagas. `real`
 * devolve o valor efetivamente pago de cada mês (contas variáveis, como luz);
 * `skip` deixa uma ocorrência passada em aberto (conta atrasada).
 */
async function fixed(
  userId: string,
  data: Omit<CreateTx, 'transactionDate' | 'recurrenceType' | 'recurrenceMonths'> & {
    dueDay: number;
    from?: Ymd;
    real?: (date: string) => number;
    skip?: (date: string) => boolean;
  },
) {
  const { dueDay, from = START, real, skip, ...rest } = data;
  const fromIndex = (from.y - START.y) * 12 + (from.m - START.m);
  const months = HISTORY_MONTHS - fromIndex + FUTURE_MONTHS;
  const first = await tx(userId, {
    ...rest,
    transactionDate: day(from, dueDay),
    recurrenceType: 'fixo',
    recurrenceMonths: months,
  });
  const seriesId = (first as { seriesId?: string | null } | null)?.seriesId;
  if (!seriesId) return;
  const occurrences = await prisma.transaction.findMany({
    where: { seriesId },
    orderBy: { transactionDate: 'asc' },
  });
  for (const occurrence of occurrences) {
    const date = occurrence.transactionDate.toISOString().slice(0, 10);
    if (!isPast(date) || skip?.(date)) continue;
    await attempt(`liquidação ${rest.description} ${date}`, () =>
      settlements.settle(userId, occurrence.id, {
        amount: real ? real(date) : undefined,
        date,
        idempotencyKey: randomUUID(),
      }),
    );
  }
}

async function categoryMap(userId: string, profileType: ProfileType) {
  const all = await prisma.category.findMany({
    where: { profileType, OR: [{ userId: null }, { userId }] },
  });
  return (name: string, type: 'income' | 'expense') => {
    const found = all.find((c) => c.name === name && c.type === type);
    if (!found)
      throw new Error(`Categoria padrão "${name}" (${type}) não encontrada. Rode db:seed.`);
    return found.id;
  };
}

// ---------------------------------------------------------------------------
// Usuários: remoção e criação.
// ---------------------------------------------------------------------------

async function removeTestUsers() {
  const emails = [TEST_USER.email, ...LEGACY_EMAILS];
  const removed = await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.whatsappContact.deleteMany({
    where: { phoneNumber: TEST_USER.whatsapp },
  });
  return removed.count;
}

async function activeSubscription(userId: string) {
  const plan = await prisma.plan.findFirst({ where: { code: 'vellun-local-dev' } });
  if (!plan) throw new Error('Plano vellun-local-dev não encontrado. Rode db:seed.');
  const start = new Date();
  const end = new Date(start);
  end.setFullYear(end.getFullYear() + 1);
  await prisma.subscription.create({
    data: {
      userId,
      planId: plan.id,
      status: SubscriptionStatus.active,
      currentPeriodStart: start,
      currentPeriodEnd: end,
    } as Prisma.SubscriptionUncheckedCreateInput,
  });
}

async function createUser(data: {
  email: string;
  name: string;
  phone: string;
  profileType: ProfileType;
}) {
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const user = await prisma.user.create({
    data: {
      email: data.email,
      name: data.name,
      phone: data.phone,
      passwordHash,
      profileType: data.profileType,
    },
  });
  await activeSubscription(user.id);
  return user.id;
}

async function account(
  userId: string,
  name: string,
  type: AccountType,
  initialBalance: number,
): Promise<string> {
  const created = await accounts.create(userId, { name, type, initialBalance } as Parameters<
    AccountsService['create']
  >[1]);
  return created.id;
}

// ---------------------------------------------------------------------------
// Pessoa física.
// ---------------------------------------------------------------------------

async function seedIndividual() {
  const r = makeRandom(1001);
  const u = TEST_USER;
  const userId = await createUser({ ...u, profileType: ProfileType.individual });
  await prisma.individualProfile.create({ data: { userId, cpf: u.cpf } });
  await prisma.whatsappContact.create({
    data: { userId, phoneNumber: u.whatsapp, provider: 'development', isVerified: true },
  });
  const cat = await categoryMap(userId, ProfileType.individual);

  // Uma conta corrente, um CDB e um cartão: o arranjo mais comum.
  const main = await account(userId, 'Conta corrente', AccountType.checking, BUDGET.checkingStart);
  const cdb = await account(userId, 'CDB', AccountType.investment, BUDGET.cdbStart);
  const created = await cards.create(userId, {
    name: 'Cartão Nubank',
    brand: 'Mastercard',
    color: '#820AD1',
    creditLimit: 6000,
    closingDay: 3,
    dueDay: 10,
    paymentAccountId: main,
  });
  // O controle de faturas começa no início do histórico (o serviço começa no
  // ciclo atual; antes de qualquer lançamento, é só recuar a data).
  await prisma.creditCard.update({
    where: { id: created.id },
    data: { invoiceTrackingStart: new Date(`${day(addMonths(START, -1), 1)}T00:00:00Z`) },
  });
  const card = created.accountId;

  // Salário uma vez por mês e contas fixas na conta corrente (débito automático).
  await fixed(userId, {
    accountId: main,
    categoryId: cat('Salário', 'income'),
    type: 'income',
    description: 'Salário',
    amount: BUDGET.salary,
    dueDay: 5,
  });
  await fixed(userId, {
    accountId: main,
    categoryId: cat('Moradia', 'expense'),
    type: 'expense',
    description: 'Aluguel',
    amount: BUDGET.rent,
    dueDay: 10,
  });
  await fixed(userId, {
    accountId: main,
    categoryId: cat('Moradia', 'expense'),
    type: 'expense',
    description: 'Conta de luz',
    amount: 180,
    dueDay: 18,
    real: () => r.money(140, 235),
  });
  await fixed(userId, {
    accountId: main,
    categoryId: cat('Moradia', 'expense'),
    type: 'expense',
    description: 'Internet',
    amount: 109.9,
    dueDay: 15,
  });
  await fixed(userId, {
    accountId: main,
    categoryId: cat('Outros', 'expense'),
    type: 'expense',
    description: 'Plano de celular',
    amount: 54.9,
    dueDay: 12,
  });

  const streaming = [
    { description: 'Netflix', amount: 44.9, day: 14 },
    { description: 'Spotify', amount: 21.9, day: 9 },
    { description: 'Amazon Prime', amount: 19.9, day: 22 },
  ];
  const markets = ['Supermercado Condor', 'Mercado Muffato', 'Atacadão'];
  const gasStations = ['Posto Ipiranga', 'Posto Shell'];
  const eatingOut = ['iFood', 'Restaurante do bairro', 'Pizzaria', 'Hamburgueria'];
  const leisure = ['Cinema', 'Bar com amigos', 'Livraria'];

  let cdbBalance = BUDGET.cdbStart;
  for (const month of MONTHS) {
    const at = (min: number, max: number) => day(month, r.int(min, max));
    const buys: CreateTx[] = [];
    const add = (category: string, description: string, amount: number, date: string) =>
      buys.push({
        accountId: card,
        categoryId: category,
        type: 'expense',
        description,
        amount,
        transactionDate: date,
      });

    // Mercado: uma compra grande no começo do mês e reposições menores.
    add(cat('Mercado', 'expense'), r.pick(markets), r.money(520, 760), at(6, 9));
    for (let i = 0; i < 3; i++)
      add(cat('Mercado', 'expense'), r.pick(markets), r.money(90, 230), at(10, 28));
    // Combustível: três abastecimentos.
    for (let i = 0; i < 3; i++)
      add(cat('Transporte', 'expense'), r.pick(gasStations), r.money(190, 260), at(1, 28));
    // Comer fora, farmácia e um lazer de vez em quando.
    for (let i = 0; i < r.int(2, 4); i++)
      add(cat('Restaurante', 'expense'), r.pick(eatingOut), r.money(45, 130), at(1, 28));
    if (r.chance(0.7)) add(cat('Saúde', 'expense'), 'Farmácia', r.money(25, 110), at(1, 28));
    if (r.chance(0.6)) add(cat('Lazer', 'expense'), r.pick(leisure), r.money(50, 180), at(1, 28));
    if (r.chance(0.5))
      add(
        cat('Outros', 'expense'),
        r.pick(['Roupas', 'Presente', 'Barbearia', 'Utilidades para casa']),
        r.money(60, 280),
        at(1, 28),
      );
    for (const s of streaming)
      add(cat('Streaming', 'expense'), s.description, s.amount, day(month, s.day));

    for (const b of buys.sort((a, b) => a.transactionDate.localeCompare(b.transactionDate))) {
      if (isPastOrToday(b.transactionDate)) await tx(userId, b);
    }

    // Aporte no CDB logo depois do salário e rendimento no fim do mês.
    const applyDate = day(month, 6);
    if (isPast(applyDate)) {
      await attempt('aporte CDB', () =>
        transfers.create(userId, {
          fromAccountId: main,
          toAccountId: cdb,
          amount: BUDGET.monthlyInvestment,
          date: applyDate,
          description: 'Aporte mensal no CDB',
          idempotencyKey: randomUUID(),
        }),
      );
      cdbBalance += BUDGET.monthlyInvestment;
    }
    const yieldDate = day(month, 28);
    if (isPast(yieldDate)) {
      const amount = Math.round(cdbBalance * BUDGET.cdbMonthlyYield * 100) / 100;
      await tx(userId, {
        accountId: cdb,
        categoryId: cat('Investimentos', 'income'),
        type: 'income',
        description: 'Rendimento do CDB',
        amount,
        transactionDate: yieldDate,
      });
      cdbBalance += amount;
    }
  }

  // Duas compras parceladas no período, como acontece de verdade.
  for (const p of [
    { at: 4, description: 'Celular novo', amount: 2399, installments: 10 },
    { at: 12, description: 'Pneus do carro', amount: 1480, installments: 4 },
  ]) {
    const date = day(MONTHS[p.at], 12);
    if (!isPastOrToday(date)) continue;
    await tx(userId, {
      accountId: card,
      categoryId: cat('Aquisição de bens', 'expense'),
      type: 'expense',
      description: p.description,
      amount: p.amount,
      transactionDate: date,
      recurrenceType: 'parcelado',
      installments: p.installments,
    });
  }

  // Faturas fechadas pagas inteiras no vencimento; a atual fica em aberto.
  const invoices = (await cards.invoices(userId, created.id)) as Array<{
    id: string;
    dueDate: string;
    remaining: number;
  }>;
  for (const invoice of invoices
    .filter((i) => isPast(i.dueDate) && i.remaining > 0)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))) {
    await attempt(`fatura ${invoice.dueDate}`, () =>
      payments.pay(userId, created.id, invoice.id, {
        sourceAccountId: main,
        amount: invoice.remaining,
        paymentDate: invoice.dueDate,
        idempotencyKey: randomUUID(),
      }),
    );
  }

  // Contas que vêm por aí, fora da rotina do mês.
  const ahead = (n: number) => addDays(TODAY, n);
  await tx(userId, {
    accountId: main,
    categoryId: cat('Transporte', 'expense'),
    type: 'expense',
    description: 'Seguro do carro (renovação)',
    amount: 1890,
    transactionDate: ahead(18),
    settle: false,
  });
  await tx(userId, {
    accountId: main,
    categoryId: cat('Transporte', 'expense'),
    type: 'expense',
    description: 'IPVA (cota única)',
    amount: 1640,
    transactionDate: ahead(50),
    settle: false,
  });

  // Metas dos gastos que mais pesam.
  for (const [name, amount] of [
    ['Mercado', 1300],
    ['Transporte', 750],
    ['Restaurante', 350],
  ] as const) {
    await attempt(`meta ${name}`, () =>
      goals.create(userId, { categoryId: cat(name, 'expense'), amount }),
    );
  }

  // Lembretes, notas e alguns compromissos.
  for (const [title, inDays, amount] of [
    ['Renovar seguro do carro', 18, 1890],
    ['Pagar IPVA', 50, 1640],
    ['Revisão do carro (20 mil km)', 32, 680],
    ['Declarar imposto de renda', 120, undefined],
  ] as const) {
    await attempt(`lembrete ${title}`, () =>
      reminders.create(userId, { title, dueDate: ahead(inDays), amount } as Parameters<
        RemindersService['create']
      >[1]),
    );
  }
  for (const [title, content] of [
    [
      'Meta do ano',
      'Chegar a R$ 60 mil no CDB até dezembro. Manter o aporte de R$ 2.000 todo mês.',
    ],
    ['Reserva de emergência', '6 meses de custo fixo ≈ R$ 25 mil. Já está coberta pelo CDB.'],
    ['Assinaturas', 'Netflix, Spotify e Prime. Rever se ainda uso as três.'],
  ]) {
    await attempt(`nota ${title}`, () => notes.create(userId, { title, content }));
  }
  for (const [title, inDays, time] of [
    ['Dentista', 9, '18:30'],
    ['Revisão do carro', 32, '08:00'],
    ['Aniversário da mãe', 15, '19:00'],
    ['Consulta médica', -12, '10:00'],
  ] as const) {
    await attempt(`evento ${title}`, () =>
      agenda.create(userId, { title, eventDate: ahead(inDays), eventTime: time, color: '#1E88E5' }),
    );
  }

  return userId;
}

// ---------------------------------------------------------------------------

async function main() {
  requireLocalDatabase();
  const started = Date.now();
  const removed = await removeTestUsers();
  if (removed) console.log(`Removidos ${removed} usuário(s) de teste anteriores.`);
  if (process.env.USABILITY_CLEANUP === 'true') return;

  console.log(`Gerando massa de usabilidade (${HISTORY_MONTHS} meses até ${TODAY})...`);
  const userId = await seedIndividual();

  const balances = await prisma.account.findMany({
    where: { userId },
    select: { name: true, currentBalance: true },
  });
  console.log('\nResumo:', {
    email: TEST_USER.email,
    lancamentos: await prisma.transaction.count({ where: { userId } }),
    saldos: Object.fromEntries(balances.map((a) => [a.name, Number(a.currentBalance)])),
    operacoes: stats.created,
    falhas: stats.failed,
    segundos: Math.round((Date.now() - started) / 1000),
  });
  console.log('\nSenha: a constante TEST_PASSWORD em prisma/seed-usability.ts.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
