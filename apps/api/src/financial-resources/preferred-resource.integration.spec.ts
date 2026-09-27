import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { CreditCardsService } from '../credit-cards/credit-cards.service';
import { FinancialResourcesService } from './financial-resources.service';

const databaseUrl = process.env.SELECTED_FEATURES_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('conta ou cartão preferencial (PostgreSQL)', () => {
  let prisma: PrismaService;
  let accounts: AccountsService;
  let cards: CreditCardsService;
  let resources: FinancialResourcesService;
  let userId: string;
  let otherId: string;

  const createUser = () =>
    prisma.user.create({
      data: {
        name: 'Preferred',
        email: `${randomUUID()}@example.test`,
        passwordHash: 'not-a-login',
        profileType: 'individual',
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
    cards = new CreditCardsService(prisma);
    resources = new FinancialResourcesService(prisma);
    [userId, otherId] = (await Promise.all([createUser(), createUser()])).map((u) => u.id);
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    await prisma.$disconnect();
  });

  it('um só preferencial entre contas e cartões; vazio limpa', async () => {
    const checking = await accounts.create(userId, { name: 'Conta', type: 'checking' });
    const card = await cards.create(userId, { name: 'Cartão', closingDay: 5, dueDay: 12 });

    expect((await resources.list(userId)).preferredAccountId).toBeNull();

    let list = await resources.setPreferred(userId, { accountId: checking.id });
    expect(list.preferredAccountId).toBe(checking.id);
    expect(list.accounts.find((a) => a.id === checking.id)?.isPreferred).toBe(true);
    expect(list.cards.find((c) => c.id === card.id)?.isPreferred).toBe(false);

    // Cartão: grava o accountId da conta interna, que é o valor dos seletores.
    list = await resources.setPreferred(userId, { cardId: card.id });
    expect(list.preferredAccountId).toBe(card.accountId);
    expect(list.accounts.every((a) => !a.isPreferred)).toBe(true);
    expect(list.cards.find((c) => c.id === card.id)?.isPreferred).toBe(true);
    expect((await cards.findOne(userId, card.id)).isPreferred).toBe(true);

    list = await resources.setPreferred(userId, {});
    expect(list.preferredAccountId).toBeNull();
  });

  it('recusa recurso de outro usuário, dois ao mesmo tempo e conta de cartão como conta', async () => {
    const mine = await accounts.create(userId, { name: 'Minha', type: 'checking' });
    const theirs = await accounts.create(otherId, { name: 'Alheia', type: 'checking' });
    const card = await cards.create(userId, { name: 'Outro cartão', closingDay: 5, dueDay: 12 });

    await expect(resources.setPreferred(userId, { accountId: theirs.id })).rejects.toMatchObject({
      status: 400,
    });
    await expect(resources.setPreferred(otherId, { cardId: card.id })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      resources.setPreferred(userId, { accountId: mine.id, cardId: card.id }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      resources.setPreferred(userId, { accountId: card.accountId }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('arquivar o cartão ou desativar a conta preferencial zera a preferência', async () => {
    const card = await cards.create(userId, { name: 'Arquivável', closingDay: 5, dueDay: 12 });
    await resources.setPreferred(userId, { cardId: card.id });
    await cards.remove(userId, card.id);
    expect((await resources.list(userId)).preferredAccountId).toBeNull();
    await expect(resources.setPreferred(userId, { cardId: card.id })).rejects.toMatchObject({
      status: 400,
    });

    const spare = await accounts.create(userId, { name: 'Sem uso', type: 'savings' });
    await resources.setPreferred(userId, { accountId: spare.id });
    await accounts.deactivate(userId, spare.id);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.preferredAccountId).toBeNull();
  });
});
