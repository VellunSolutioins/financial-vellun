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
import { addDaysSaoPaulo, dateOnlyString, todaySaoPaulo } from '../common/date.util';
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
    await prisma.featureFlag.deleteMany({ where: { key: 'whatsapp_summary' } });
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
});
