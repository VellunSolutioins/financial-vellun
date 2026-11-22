import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ObservabilityModule } from '../observability/observability.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { SecurityEventsModule } from '../security-events/security-events.module';
import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { TransactionsService } from '../transactions/transactions.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { CreditCardsService } from '../credit-cards/credit-cards.service';
import { addDaysSaoPaulo, dateOnlyString, parseDateOnly, todaySaoPaulo } from '../common/date.util';
import { InternalModule } from './internal.module';

const databaseUrl = process.env.SELECTED_FEATURES_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

/**
 * Rotas do agente de WhatsApp (docs/plans/018, Fase 1) com o módulo real:
 * injeção, chave interna, feature flag e os números do dashboard.
 */
integration('ações internas do agente (PostgreSQL)', () => {
  // Gerada a cada execução: não é segredo de nenhum ambiente.
  const internalKey = randomUUID() + randomUUID();
  let app: INestApplication;
  let prisma: PrismaService;
  const userIds: string[] = [];
  const today = todaySaoPaulo();
  const inDays = (n: number) => dateOnlyString(addDaysSaoPaulo(today, n));
  const testEnv: Record<string, string> = {
    INTERNAL_API_KEY_AGENT_TO_API: internalKey,
    // Sem assinatura nos usuários de teste: a regra de acesso tem testes próprios.
    BILLING_ENFORCEMENT_ENABLED: 'false',
  };
  const savedEnv: Record<string, string | undefined> = {};

  const setFlag = (enabled: boolean) =>
    prisma.featureFlag.upsert({
      where: { key: 'whatsapp_summary' },
      create: { key: 'whatsapp_summary', enabled },
      update: { enabled },
    });

  const setPaymentsFlag = (enabled: boolean) =>
    prisma.featureFlag.upsert({
      where: { key: 'whatsapp_payments' },
      create: { key: 'whatsapp_payments', enabled },
      update: { enabled },
    });

  const api = () => request(app.getHttpServer());
  const openItems = (userId: string, type: 'expense' | 'income') =>
    api()
      .get(`/internal/users/${userId}/open-items`)
      .query({ type })
      .set('x-internal-api-key', internalKey);

  const summary = (userId: string, query: Record<string, string> = {}) =>
    request(app.getHttpServer())
      .get(`/internal/users/${userId}/summary`)
      .query(query)
      .set('x-internal-api-key', internalKey);

  async function createUser(profileType: 'individual' | 'business') {
    const user = await prisma.user.create({
      data: {
        name: 'Agente',
        email: `${randomUUID()}@example.test`,
        passwordHash: 'not-a-login',
        profileType,
      },
    });
    userIds.push(user.id);
    return user.id;
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      !url.pathname.endsWith('_validation')
    ) {
      throw new Error('Use a local database with a name ending in _validation');
    }
    prisma = new PrismaService({ datasources: { db: { url: databaseUrl } } });
    await prisma.$connect();

    // O ConfigService lê o process.env antes de qualquer `load`: é ali que a
    // chave do teste precisa estar, ou vale a do `.env` do desenvolvedor.
    for (const [name, value] of Object.entries(testEnv)) {
      savedEnv[name] = process.env[name];
      process.env[name] = value;
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        // Os módulos globais do AppModule (Redis fica em memória sem REDIS_URL).
        PrismaModule,
        ObservabilityModule,
        RedisModule,
        SecurityEventsModule,
        InternalModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (!prisma) return;
    await prisma.featureFlag.deleteMany({
      where: { key: { in: ['whatsapp_summary', 'whatsapp_payments'] } },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app?.close();
    await prisma.$disconnect();
  });

  it('recusa sem a chave interna', async () => {
    const userId = await createUser('individual');
    await setFlag(true);

    await request(app.getHttpServer()).get(`/internal/users/${userId}/summary`).expect(401);
  });

  it('com a flag desligada responde FEATURE_DISABLED', async () => {
    const userId = await createUser('individual');
    await setFlag(false);

    const response = await summary(userId).expect(403);
    expect(response.body.code).toBe('FEATURE_DISABLED');
  });

  it('pessoa física recebe os mesmos números do dashboard do app', async () => {
    const userId = await createUser('individual');
    await setFlag(true);
    const accounts = new AccountsService(prisma);
    const transactions = new TransactionsService(prisma, accounts);
    const checking = (
      await accounts.create(userId, { name: 'Itaú', type: 'checking', initialBalance: 1000 })
    ).id;
    const create = (
      type: 'income' | 'expense',
      amount: number,
      date: string,
      description: string,
    ) =>
      transactions.create(userId, {
        accountId: checking,
        type,
        amount,
        description,
        transactionDate: date,
      } as any);
    await create('expense', 120, inDays(0), 'Mercado');
    await create('income', 3000, inDays(0), 'Salário');
    await create('expense', 90, inDays(1), 'Internet');

    const response = await summary(userId).expect(200);
    const dashboard = await new DashboardService(prisma).getSummary(userId);

    expect(response.body).toMatchObject({
      profileType: 'individual',
      period: dashboard.period,
      cashBalance: dashboard.cashBalance,
      spent: dashboard.spending.realized,
      received: dashboard.income.received,
      result: dashboard.result.value,
      byCategoryComplete: true,
    });
    expect(response.body.spent).toBe(120);
    expect(response.body.received).toBe(3000);
    expect(response.body.upcoming).toEqual([
      expect.objectContaining({ description: 'Internet', remaining: 90, kind: 'bill' }),
    ]);
  });

  it('pessoa jurídica usa o dashboard empresarial e devolve o período', async () => {
    const userId = await createUser('business');
    await setFlag(true);

    const response = await summary(userId, {
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
    }).expect(200);

    expect(response.body).toMatchObject({
      profileType: 'business',
      period: { start: '2026-01-01', end: '2026-01-31' },
      spent: 0,
      received: 0,
      byCategoryComplete: false,
      cardsDebt: null,
    });
  });

  it('valida o período', async () => {
    const userId = await createUser('individual');
    await setFlag(true);

    await summary(userId, { periodStart: '01/11/2026' }).expect(400);
    await summary(userId, { periodStart: '2026-11-30', periodEnd: '2026-11-01' }).expect(400);
  });

  it('usuário inexistente é 404', async () => {
    await setFlag(true);
    await summary(randomUUID()).expect(404);
  });

  // ── Fase 2: baixa e fatura ─────────────────────────────────────────────────
  async function personalWithAccount() {
    const userId = await createUser('individual');
    const accounts = new AccountsService(prisma);
    const transactions = new TransactionsService(prisma, accounts);
    const checking = (
      await accounts.create(userId, { name: 'Itaú', type: 'checking', initialBalance: 1000 })
    ).id;
    const create = (
      type: 'income' | 'expense',
      amount: number,
      date: string,
      description: string,
    ) =>
      transactions.create(userId, {
        accountId: checking,
        type,
        amount,
        description,
        transactionDate: date,
      } as any);
    return { userId, transactions, checking, create };
  }

  it('baixa e fatura respondem FEATURE_DISABLED com a flag desligada', async () => {
    const userId = await createUser('individual');
    await setPaymentsFlag(false);

    const response = await openItems(userId, 'expense').expect(403);
    expect(response.body.code).toBe('FEATURE_DISABLED');
  });

  it('lista o que está em aberto do tipo pedido, até 45 dias à frente', async () => {
    const { userId, create } = await personalWithAccount();
    await setPaymentsFlag(true);
    const luz = await create('expense', 120, inDays(3), 'Luz');
    await create('expense', 50, inDays(60), 'Longe demais');
    const salario = await create('income', 3000, inDays(5), 'Salário');

    const despesas = (await openItems(userId, 'expense').expect(200)).body;
    expect(despesas.entries).toEqual([
      expect.objectContaining({
        id: luz.id,
        description: 'Luz',
        remaining: 120,
        dueDate: inDays(3),
        isOverdue: false,
        accountName: 'Itaú',
      }),
    ]);
    expect(despesas.invoices).toEqual([]);

    const receitas = (await openItems(userId, 'income').expect(200)).body;
    expect(receitas.entries.map((e: any) => e.id)).toEqual([salario.id]);
  });

  it('baixa parcial e total, idempotente pela chave', async () => {
    const { userId, create, checking } = await personalWithAccount();
    await setPaymentsFlag(true);
    const luz = await create('expense', 120, inDays(2), 'Luz');
    const settle = (amount: number | undefined, idempotencyKey: string) =>
      api()
        .post(`/internal/users/${userId}/transactions/${luz.id}/settlements`)
        .set('x-internal-api-key', internalKey)
        .send({ ...(amount ? { amount } : {}), date: inDays(0), idempotencyKey });

    const key = `job-${randomUUID()}`;
    await settle(50, key).expect(201);
    // O mesmo job reprocessado não paga de novo.
    await settle(50, key).expect(201);
    let open = (await openItems(userId, 'expense').expect(200)).body.entries;
    expect(open).toEqual([expect.objectContaining({ id: luz.id, remaining: 70 })]);

    // Sem valor, quita o restante.
    await settle(undefined, `job-${randomUUID()}`).expect(201);
    open = (await openItems(userId, 'expense').expect(200)).body.entries;
    expect(open).toEqual([]);

    const account = await prisma.account.findUniqueOrThrow({ where: { id: checking } });
    expect(Number(account.currentBalance)).toBe(880);
  });

  it('valor acima do restante é recusado com a mensagem da API', async () => {
    const { userId, create } = await personalWithAccount();
    await setPaymentsFlag(true);
    const luz = await create('expense', 120, inDays(2), 'Luz');

    const response = await api()
      .post(`/internal/users/${userId}/transactions/${luz.id}/settlements`)
      .set('x-internal-api-key', internalKey)
      .send({ amount: 500, date: inDays(0), idempotencyKey: `job-${randomUUID()}` })
      .expect(400);
    expect(response.body.message).toContain('passa do que falta');
  });

  it('não baixa lançamento de outro usuário', async () => {
    const { create } = await personalWithAccount();
    const other = await createUser('individual');
    await setPaymentsFlag(true);
    const luz = await create('expense', 120, inDays(2), 'Luz');

    await api()
      .post(`/internal/users/${other}/transactions/${luz.id}/settlements`)
      .set('x-internal-api-key', internalKey)
      .send({ date: inDays(0), idempotencyKey: `job-${randomUUID()}` })
      .expect(404);
  });

  it('lista a fatura com saldo e registra o pagamento', async () => {
    const { userId, transactions, checking } = await personalWithAccount();
    await setPaymentsFlag(true);
    const cards = new CreditCardsService(prisma);
    const card = await cards.create(userId, { name: 'Nubank', closingDay: 10, dueDay: 17 });
    await prisma.creditCard.update({
      where: { id: card.id },
      data: { invoiceTrackingStart: parseDateOnly('2026-01-01') },
    });
    await transactions.create(userId, {
      accountId: card.accountId,
      type: 'expense',
      amount: 300,
      description: 'Mercado',
      transactionDate: inDays(0),
    } as any);

    const { invoices } = (await openItems(userId, 'expense').expect(200)).body;
    expect(invoices).toEqual([
      expect.objectContaining({ cardId: card.id, cardName: 'Nubank', remaining: 300 }),
    ]);

    await api()
      .post(`/internal/users/${userId}/cards/${card.id}/invoices/${invoices[0].invoiceId}/payments`)
      .set('x-internal-api-key', internalKey)
      .send({
        sourceAccountId: checking,
        amount: 100,
        paymentDate: inDays(0),
        idempotencyKey: `job-${randomUUID()}`,
      })
      .expect(201);

    const after = (await openItems(userId, 'expense').expect(200)).body.invoices;
    expect(after).toEqual([expect.objectContaining({ remaining: 200 })]);
  });
});
