import { randomUUID } from 'crypto';
import { ProfileType } from '@prisma/client';

import { PrismaService } from '../src/prisma/prisma.service';
import { AccountsService } from '../src/accounts/accounts.service';
import { AccountBalanceScheduler } from '../src/accounts/account-balance.scheduler';
import { TransactionsService } from '../src/transactions/transactions.service';
import { SettlementsService } from '../src/transactions/settlements.service';
import { InstallmentsService } from '../src/transactions/installments.service';
import { RecurrencesService } from '../src/transactions/recurrences.service';
import { CreditCardsService } from '../src/credit-cards/credit-cards.service';
import { CardPaymentsService } from '../src/credit-cards/card-payments.service';
import { DashboardService } from '../src/dashboard/dashboard.service';
import { TransfersService } from '../src/transfers/transfers.service';
import { addDaysSaoPaulo, dateOnlyString, todaySaoPaulo } from '../src/common/date.util';

/**
 * Ambiente dos testes de integração do modelo financeiro (docs/adrs/0018):
 * serviços reais sobre um Postgres local de validação. Mesma regra dos demais
 * `*.integration.spec.ts`: só roda com `SELECTED_FEATURES_TEST_DATABASE_URL`
 * apontando para `localhost` e um banco cujo nome termina em `_validation` —
 * nunca produção.
 */
export const validationDatabaseUrl = process.env.SELECTED_FEATURES_TEST_DATABASE_URL;
export const integration = validationDatabaseUrl ? describe : describe.skip;

export async function createFinancialEnv() {
  const url = new URL(validationDatabaseUrl!);
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.endsWith('_validation')) {
    throw new Error('Use a local database with a name ending in _validation');
  }
  const prisma = new PrismaService({ datasources: { db: { url: validationDatabaseUrl } } });
  await prisma.$connect();
  const accounts = new AccountsService(prisma);
  const transactions = new TransactionsService(prisma, accounts);
  const env = {
    prisma,
    accounts,
    transactions,
    settlements: new SettlementsService(prisma, accounts),
    installments: new InstallmentsService(prisma, accounts, transactions),
    recurrences: new RecurrencesService(prisma, accounts, transactions),
    cards: new CreditCardsService(prisma),
    payments: new CardPaymentsService(prisma, accounts),
    dashboard: new DashboardService(prisma),
    transfers: new TransfersService(prisma, accounts),
    scheduler: new AccountBalanceScheduler(prisma, accounts),
    userIds: [] as string[],

    async createUser(profileType: ProfileType = 'individual') {
      const user = await prisma.user.create({
        data: {
          name: 'Modelo financeiro',
          email: `${randomUUID()}@example.test`,
          passwordHash: 'not-a-login',
          profileType,
        },
      });
      env.userIds.push(user.id);
      return user.id;
    },

    async account(
      userId: string,
      initialBalance = 0,
      type: 'checking' | 'investment' | 'loan' = 'checking',
    ) {
      return (
        await accounts.create(userId, {
          name: `Conta ${randomUUID().slice(0, 4)}`,
          type,
          initialBalance,
        })
      ).id;
    },

    async balance(accountId: string) {
      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      return Number(account.currentBalance);
    },

    async close() {
      if (env.userIds.length) {
        await prisma.user.deleteMany({ where: { id: { in: env.userIds } } });
      }
      await prisma.$disconnect();
    },
  };
  return env;
}

export type FinancialEnv = Awaited<ReturnType<typeof createFinancialEnv>>;

/** Dia relativo a hoje em São Paulo, como `YYYY-MM-DD`. */
export function dayFromToday(days: number) {
  return dateOnlyString(addDaysSaoPaulo(todaySaoPaulo(), days));
}

export const key = () => randomUUID();
