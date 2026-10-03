import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { TransactionsService } from '../transactions/transactions.service';
import { FinancialResourcesService } from '../financial-resources/financial-resources.service';
import { CreditCardsService } from './credit-cards.service';

const databaseUrl = process.env.SELECTED_FEATURES_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

/**
 * Trecho de backfill da migração da fase 1, reexecutável (idempotente). A
 * coluna `is_primary` foi removida depois (migração `preferred_account`, ADR
 * 0016): o `UPDATE` que marcava o "cartão principal" fica de fora e o `INSERT`
 * perde a coluna. No banco, a migração original já rodou como estava.
 */
function backfillStatements(): string[] {
  const sql = readFileSync(
    join(__dirname, '../../prisma/migrations/20260924150000_card_account_integrity/migration.sql'),
    'utf8',
  );
  const body = sql.split('-- backfill:begin')[1].split('-- backfill:end')[0];
  return body
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) =>
      s
        .trim()
        .replace('"account_id", "is_primary",', '"account_id",')
        .replace('a."id", false,', 'a."id",'),
    )
    .filter((s) => s && !s.includes('is_primary'));
}

integration('contas e cartões separados (PostgreSQL)', () => {
  let prisma: PrismaService;
  let accounts: AccountsService;
  let transactions: TransactionsService;
  let cards: CreditCardsService;
  let resources: FinancialResourcesService;
  let userId: string;
  let otherId: string;
  let businessId: string;
  let checkingId: string;

  const createUser = (profileType: 'individual' | 'business') =>
    prisma.user.create({
      data: {
        name: 'Card integration',
        email: `${randomUUID()}@example.test`,
        passwordHash: 'not-a-login',
        profileType,
      },
    });

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
    accounts = new AccountsService(prisma);
    transactions = new TransactionsService(prisma, accounts);
    cards = new CreditCardsService(prisma);
    resources = new FinancialResourcesService(prisma);
    [userId, otherId, businessId] = (
      await Promise.all([
        createUser('individual'),
        createUser('individual'),
        createUser('business'),
      ])
    ).map((u) => u.id);
    checkingId = (
      await accounts.create(userId, { name: 'Checking', type: 'checking', initialBalance: 100 })
    ).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId, businessId] } } });
    await prisma.$disconnect();
  });

  it('cria conta interna e cartão juntos; falha no cartão não deixa conta órfã', async () => {
    const name = `Atomic ${randomUUID()}`;
    // Fora de 1–31: o CHECK do banco derruba o INSERT do cartão, depois da conta.
    await expect(
      cards.create(userId, { name, closingDay: 40, dueDay: 10 } as any),
    ).rejects.toThrow();
    expect(await prisma.account.count({ where: { userId, name } })).toBe(0);

    const card = await cards.create(userId, {
      name: 'Visa',
      closingDay: 31,
      dueDay: 8,
      paymentAccountId: checkingId,
    });
    expect(card).toMatchObject({
      closingDay: 31,
      dueDay: 8,
      paymentAccountId: checkingId,
      needsSetup: false,
      isActive: true,
      isPreferred: false,
    });
    expect(card.invoiceTrackingStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: card.accountId } });
    expect(account.type).toBe('credit_card');
  });

  it('lista contas e cartões separados e bloqueia a conta interna em /accounts', async () => {
    const card = (await cards.findAll(userId))[0];

    expect((await accounts.findAll(userId)).map((a) => a.id)).toEqual([checkingId]);
    const listed = await resources.list(userId);
    expect(listed.accounts.map((a) => a.id)).toEqual([checkingId]);
    expect(listed.cards).toEqual([
      expect.objectContaining({ id: card.id, accountId: card.accountId, name: 'Visa' }),
    ]);

    await expect(accounts.findOne(userId, card.accountId)).rejects.toMatchObject({ status: 409 });
    await expect(
      accounts.update(userId, card.accountId, { name: 'Renomeado' }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(accounts.deactivate(userId, card.accountId)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      accounts.create(userId, { name: 'Fake card', type: 'credit_card' as any }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      accounts.update(userId, checkingId, { type: 'credit_card' as any }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('isola por usuário', async () => {
    const card = (await cards.findAll(userId))[0];
    expect(await cards.findAll(otherId)).toEqual([]);
    expect(await resources.list(otherId)).toEqual({
      preferredAccountId: null,
      accounts: [],
      cards: [],
    });
    await expect(cards.findOne(otherId, card.id)).rejects.toMatchObject({ status: 404 });
    await expect(cards.update(otherId, card.id, { name: 'x' })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      cards.create(otherId, { name: 'x', closingDay: 1, dueDay: 10, paymentAccountId: checkingId }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      cards.update(userId, card.id, { paymentAccountId: card.accountId }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('cartão é só do perfil pessoal', async () => {
    await expect(
      cards.create(businessId, { name: 'PJ', closingDay: 1, dueDay: 10 }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('cartão arquivado não recebe compra, mas o histórico segue editável', async () => {
    const card = await cards.create(userId, { name: 'Archive me', closingDay: 5, dueDay: 12 });
    const tx = await transactions.create(userId, {
      accountId: card.accountId,
      type: 'expense',
      amount: 50,
      description: 'Antes de arquivar',
      transactionDate: '2026-01-10',
    });

    await cards.remove(userId, card.id);

    expect((await cards.findAll(userId)).map((c) => c.id)).not.toContain(card.id);
    const withArchived = await cards.findAll(userId, true);
    expect(withArchived.find((c) => c.id === card.id)).toMatchObject({ isActive: false });
    expect(withArchived[withArchived.length - 1].id).toBe(card.id);

    await expect(
      transactions.create(userId, {
        accountId: card.accountId,
        type: 'expense',
        amount: 10,
        description: 'Depois de arquivar',
        transactionDate: '2026-01-11',
      }),
    ).rejects.toThrow('Cartão arquivado não recebe novas compras');
    await expect(
      transactions.update(userId, tx.id, { accountId: tx.accountId, description: 'Editada' }),
    ).resolves.toMatchObject({ description: 'Editada' });
  });

  it('migração: conta de cartão órfã vira cartão pendente (PF) ou conta comum (PJ)', async () => {
    const legacyUser = await createUser('individual');
    const pfOrphan = await prisma.account.create({
      data: { userId: legacyUser.id, name: 'Cartão antigo', type: 'credit_card' },
    });
    const legacyTx = await prisma.transaction.create({
      data: {
        userId: legacyUser.id,
        accountId: pfOrphan.id,
        type: 'expense',
        amount: 80,
        description: 'Compra antiga',
        transactionDate: new Date('2025-03-10T12:00:00Z'),
        eventDate: new Date('2025-03-10T12:00:00Z'),
      },
    });
    const pjOrphan = await prisma.account.create({
      data: { userId: businessId, name: 'Cartão da empresa', type: 'credit_card' },
    });

    try {
      for (const statement of backfillStatements()) await prisma.$executeRawUnsafe(statement);

      const migrated = await prisma.creditCard.findUniqueOrThrow({
        where: { accountId: pfOrphan.id },
      });
      expect(migrated).toMatchObject({
        closingDay: null,
        dueDay: null,
        invoiceTrackingStart: null,
      });
      const view = await cards.findOne(legacyUser.id, migrated.id);
      expect(view).toMatchObject({
        accountId: pfOrphan.id,
        needsSetup: true,
        name: 'Cartão antigo',
      });
      await expect(
        cards.update(legacyUser.id, migrated.id, { closingDay: 10 }),
      ).rejects.toMatchObject({ status: 409 });

      // Nenhum lançamento é tocado.
      const after = await prisma.transaction.findUniqueOrThrow({ where: { id: legacyTx.id } });
      expect(after).toEqual(legacyTx);

      expect((await prisma.account.findUniqueOrThrow({ where: { id: pjOrphan.id } })).type).toBe(
        'other',
      );
      expect(await prisma.creditCard.count({ where: { accountId: pjOrphan.id } })).toBe(0);

      // Reexecutar não duplica nada.
      for (const statement of backfillStatements()) await prisma.$executeRawUnsafe(statement);
      expect(await prisma.creditCard.count({ where: { accountId: pfOrphan.id } })).toBe(1);
    } finally {
      await prisma.user.delete({ where: { id: legacyUser.id } });
    }
  });
});
