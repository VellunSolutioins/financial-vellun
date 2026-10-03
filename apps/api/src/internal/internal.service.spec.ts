import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InternalService } from './internal.service';

/** Cria um mock mínimo do PrismaService com as entidades usadas pelo serviço. */
function createPrismaMock() {
  const mock: any = {
    whatsappContact: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    aiConversation: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    aiMessage: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    user: { findUnique: jest.fn() },
    account: { findMany: jest.fn(), findUnique: jest.fn() },
    category: { findMany: jest.fn(), findUnique: jest.fn() },
    transaction: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    aiExtractedTransaction: { update: jest.fn(), create: jest.fn(), findUnique: jest.fn() },
    installmentPurchase: { create: jest.fn() },
    transactionSettlement: { create: jest.fn().mockResolvedValue({}) },
  };
  // `$transaction(fn)` executa o callback com o próprio mock como client.
  mock.$transaction = jest.fn(async (fn: any) => fn(mock));
  // `SELECT ... FOR UPDATE` que serializa a criação da conversa por contato.
  mock.$queryRaw = jest.fn().mockResolvedValue([]);
  return mock;
}

/** Cartão com fechamento, vencimento e início do controle definidos. */
function configuredCard(id: string) {
  return { id, closingDay: 3, dueDay: 10, invoiceTrackingStart: new Date('2026-01-01') };
}

describe('InternalService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: InternalService;

  let access: { canUseProduct: jest.Mock; isEnforced: jest.Mock };
  // A atribuição de fatura tem teste próprio (integração com o banco).
  const ledger = { syncTransactions: jest.fn().mockResolvedValue(undefined) };

  beforeEach(() => {
    ledger.syncTransactions.mockClear();
    prisma = createPrismaMock();
    access = {
      canUseProduct: jest.fn().mockResolvedValue({ allowed: true }),
      isEnforced: jest.fn().mockReturnValue(true),
    };
    service = new InternalService(prisma as any, {} as any, access as any, ledger as any);
  });

  describe('findContactByPhone (vínculo verificado)', () => {
    const user = { id: 'u1', name: 'Joao', profileType: 'individual' };
    const contact = (overrides: Record<string, unknown>) => ({
      id: 'contact1',
      userId: 'u1',
      user,
      isVerified: true,
      revokedAt: null,
      linkVersion: 3,
      ...overrides,
    });

    it('devolve usuário, contato e versão do vínculo quando verificado', async () => {
      prisma.whatsappContact.findUnique.mockResolvedValue(contact({}));

      await expect(service.findContactByPhone('+5511999999999')).resolves.toEqual({
        userId: 'u1',
        name: 'Joao',
        profileType: 'individual',
        isVerified: true,
        contactId: 'contact1',
        linkVersion: 3,
      });
    });

    it('número só declarado (não verificado) não identifica ninguém', async () => {
      prisma.whatsappContact.findUnique.mockResolvedValue(contact({ isVerified: false }));

      await expect(service.findContactByPhone('+5511999999999')).rejects.toThrow(
        'Contato não vinculado',
      );
    });

    it('número revogado numa troca de telefone não identifica ninguém', async () => {
      prisma.whatsappContact.findUnique.mockResolvedValue(
        contact({ isVerified: false, revokedAt: new Date() }),
      );

      await expect(service.findContactByPhone('+5511999999999')).rejects.toThrow(
        'Contato não vinculado',
      );
    });
  });

  describe('listRecentMessagesByPhone', () => {
    it('normaliza o telefone ao buscar o contato', async () => {
      prisma.whatsappContact.findUnique.mockResolvedValue(null);

      await service.listRecentMessagesByPhone('11999999999');

      expect(prisma.whatsappContact.findUnique).toHaveBeenCalledWith({
        where: { phoneNumber: '+5511999999999' },
      });
    });

    it('retorna vazio quando não há contato', async () => {
      prisma.whatsappContact.findUnique.mockResolvedValue(null);

      const result = await service.listRecentMessagesByPhone('+5511999999999');

      expect(result).toEqual({ conversationId: null, messages: [] });
    });

    it('retorna vazio quando não há conversa ativa', async () => {
      prisma.whatsappContact.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.aiConversation.findFirst.mockResolvedValue(null);

      const result = await service.listRecentMessagesByPhone('+5511999999999');

      expect(result).toEqual({ conversationId: null, messages: [] });
    });

    it('limita o take a no máximo 50 e devolve em ordem cronológica', async () => {
      prisma.whatsappContact.findUnique.mockResolvedValue({ id: 'c1' });
      prisma.aiConversation.findFirst.mockResolvedValue({ id: 'conv1' });
      // findMany devolve desc; o serviço inverte para cronológico.
      prisma.aiMessage.findMany.mockResolvedValue([
        { id: 'm2', content: 'b' },
        { id: 'm1', content: 'a' },
      ]);

      const result = await service.listRecentMessagesByPhone('+5511999999999', 100);

      expect(prisma.aiMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50, where: { conversationId: 'conv1' } }),
      );
      expect(result.conversationId).toBe('conv1');
      expect(result.messages.map((m: any) => m.id)).toEqual(['m1', 'm2']);
    });
  });

  describe('controle de assinatura', () => {
    it('listAccounts bloqueia usuário sem assinatura', async () => {
      access.canUseProduct.mockResolvedValue({ allowed: false });

      await expect(service.listAccounts('u1')).rejects.toMatchObject({
        getResponse: expect.any(Function),
      });
      expect(prisma.account.findMany).not.toHaveBeenCalled();
    });

    it('listAccounts libera usuário com assinatura', async () => {
      access.canUseProduct.mockResolvedValue({ allowed: true });
      prisma.account.findMany.mockResolvedValue([{ id: 'a1', type: 'checking', creditCard: null }]);

      const result = await service.listAccounts('u1');

      expect(access.canUseProduct).toHaveBeenCalledWith('u1');
      expect(result).toEqual([
        {
          id: 'a1',
          type: 'checking',
          kind: 'account',
          cardId: null,
          isPreferred: false,
          needsSetup: false,
        },
      ]);
    });

    it('createTransactionFromAi bloqueia antes de tocar no banco quando sem assinatura', async () => {
      access.canUseProduct.mockResolvedValue({ allowed: false });

      await expect(
        service.createTransactionFromAi({ userId: 'u1', accountId: 'a1' } as any),
      ).rejects.toMatchObject({ getResponse: expect.any(Function) });
      expect(prisma.account.findUnique).not.toHaveBeenCalled();
    });

    it('libera listAccounts quando a obrigatoriedade está desligada (rollout)', async () => {
      access.isEnforced.mockReturnValue(false);
      access.canUseProduct.mockResolvedValue({ allowed: false });
      prisma.account.findMany.mockResolvedValue([{ id: 'a1', type: 'checking', creditCard: null }]);

      const result = await service.listAccounts('u1');

      expect(result).toMatchObject([{ id: 'a1', kind: 'account', cardId: null }]);
      expect(access.canUseProduct).not.toHaveBeenCalled();
    });

    it('createTransactionFromAi rejeita conta de outro usuário (userId manipulado)', async () => {
      access.canUseProduct.mockResolvedValue({ allowed: true });
      prisma.account.findUnique.mockResolvedValue({ id: 'a1', userId: 'outro', isActive: true });

      await expect(
        service.createTransactionFromAi({ userId: 'u1', accountId: 'a1' } as any),
      ).rejects.toThrow('Conta inválida para o usuário');
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });

    it('createTransactionFromAi recusa receita parcelada', async () => {
      prisma.account.findUnique.mockResolvedValue({
        id: 'a1',
        userId: 'u1',
        type: 'checking',
        isActive: true,
      });

      await expect(
        service.createTransactionFromAi({
          userId: 'u1',
          accountId: 'a1',
          type: 'income',
          recurrenceType: 'parcelado',
          installments: 3,
        } as any),
      ).rejects.toThrow('Parcelamento só existe para despesas.');
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });

    it('createTransactionFromAi recusa compra em cartão arquivado', async () => {
      prisma.account.findUnique.mockResolvedValue({
        id: 'a1',
        userId: 'u1',
        type: 'credit_card',
        isActive: false,
      });

      await expect(
        service.createTransactionFromAi({ userId: 'u1', accountId: 'a1' } as any),
      ).rejects.toThrow('Cartão arquivado não recebe novas compras');
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });

    it('listAccounts marca cartões com kind = card e o id da conta interna', async () => {
      prisma.account.findMany.mockResolvedValue([
        { id: 'a1', name: 'Itaú', type: 'checking', creditCard: null },
        { id: 'a2', name: 'Nubank', type: 'credit_card', creditCard: configuredCard('c1') },
      ]);

      const result = await service.listAccounts('u1');

      expect(result).toEqual([
        {
          id: 'a1',
          name: 'Itaú',
          type: 'checking',
          kind: 'account',
          cardId: null,
          isPreferred: false,
          needsSetup: false,
        },
        {
          id: 'a2',
          name: 'Nubank',
          type: 'credit_card',
          kind: 'card',
          cardId: 'c1',
          isPreferred: false,
          needsSetup: false,
        },
      ]);
    });

    // O agente usa o "Padrão nos lançamentos" quando a mensagem não cita conta.
    it('listAccounts marca o recurso preferencial do usuário, inclusive cartão', async () => {
      prisma.account.findMany.mockResolvedValue([
        { id: 'a1', name: 'Itaú', type: 'checking', creditCard: null },
        { id: 'a2', name: 'Nubank', type: 'credit_card', creditCard: configuredCard('c1') },
      ]);
      prisma.user.findUnique.mockResolvedValue({ preferredAccountId: 'a2' });

      const result = await service.listAccounts('u1');

      expect(result.map((r) => [r.id, r.isPreferred])).toEqual([
        ['a1', false],
        ['a2', true],
      ]);
    });

    it('listAccounts marca o cartão sem fechamento/vencimento como needsSetup', async () => {
      prisma.account.findMany.mockResolvedValue([
        {
          id: 'a2',
          name: 'Nubank',
          type: 'credit_card',
          creditCard: { ...configuredCard('c1'), closingDay: null },
        },
      ]);

      const [card] = await service.listAccounts('u1');

      expect(card.needsSetup).toBe(true);
    });

    it('createTransactionFromAi rejeita categoria de outro usuário', async () => {
      prisma.account.findUnique.mockResolvedValue({ id: 'a1', userId: 'u1', isActive: true });
      prisma.category.findUnique.mockResolvedValue({ id: 'cat1', userId: 'outro' });

      await expect(
        service.createTransactionFromAi({
          userId: 'u1',
          accountId: 'a1',
          categoryId: 'cat1',
        } as any),
      ).rejects.toThrow('Categoria inválida para o usuário');
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });

    it('createTransactionFromAi rejeita categoria de receita numa despesa', async () => {
      prisma.account.findUnique.mockResolvedValue({ id: 'a1', userId: 'u1', isActive: true });
      prisma.category.findUnique.mockResolvedValue({
        id: 'cat1',
        userId: null,
        type: 'income',
        profileType: 'individual',
      });

      await expect(
        service.createTransactionFromAi({
          userId: 'u1',
          accountId: 'a1',
          categoryId: 'cat1',
          type: 'expense',
        } as any),
      ).rejects.toThrow('Categoria incompatível com o tipo do lançamento');
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });

    it('createTransactionFromAi rejeita categoria do outro perfil (PF x PJ)', async () => {
      prisma.account.findUnique.mockResolvedValue({ id: 'a1', userId: 'u1', isActive: true });
      prisma.category.findUnique.mockResolvedValue({
        id: 'cat1',
        userId: null,
        type: 'expense',
        profileType: 'business',
      });
      prisma.user.findUnique.mockResolvedValue({ profileType: 'individual' });

      await expect(
        service.createTransactionFromAi({
          userId: 'u1',
          accountId: 'a1',
          categoryId: 'cat1',
          type: 'expense',
        } as any),
      ).rejects.toThrow('Categoria de outro perfil');
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });
  });

  describe('createTransactionFromAi (recorrência)', () => {
    const base = {
      userId: 'u1',
      accountId: 'a1',
      type: 'expense',
      description: 'TV',
      transactionDate: '2026-09-27',
      source: 'whatsapp',
      idempotencyKey: 'job-9',
    } as any;

    beforeEach(() => {
      prisma.account.findUnique.mockResolvedValue({ id: 'a1', userId: 'u1', isActive: true });
      prisma.transaction.findUnique.mockResolvedValue(null);
      let n = 0;
      prisma.transaction.create.mockImplementation(async ({ data }: any) => ({
        id: `t${++n}`,
        accountId: 'a1',
        status: 'confirmed',
        ...data,
      }));
      prisma.transaction.findMany = jest.fn(async () =>
        prisma.transaction.create.mock.calls.map((_: unknown, i: number) => ({ id: `t${i + 1}` })),
      );
      service = new InternalService(
        prisma as any,
        { recalculateBalance: jest.fn() } as any,
        access as any,
        ledger as any,
      );
    });

    const created = () => prisma.transaction.create.mock.calls.map(([arg]: any) => arg.data);
    const dates = (rows: any[]) =>
      rows.map((r) => (r.transactionDate as Date).toISOString().slice(0, 10));

    it('sem recorrência cria um único lançamento avulso', async () => {
      await service.createTransactionFromAi({ ...base, amount: 50 });

      expect(created()).toHaveLength(1);
      expect(created()[0]).toMatchObject({ recurrenceType: 'avulso', seriesId: null });
    });

    it('parcelado divide o total em N parcelas mensais e vincula todas às faturas', async () => {
      await service.createTransactionFromAi({
        ...base,
        amount: 100,
        recurrenceType: 'parcelado',
        installments: 3,
      });

      const rows = created();
      expect(rows.map((r: any) => r.amount)).toEqual([33.33, 33.33, 33.34]);
      expect(rows.map((r: any) => r.installmentNumber)).toEqual([1, 2, 3]);
      expect(rows.every((r: any) => r.installmentTotal === 3)).toBe(true);
      expect(new Set(rows.map((r: any) => r.seriesId)).size).toBe(1);
      expect(rows[0].seriesId).toEqual(expect.any(String));
      expect(dates(rows)).toEqual(['2026-09-27', '2026-10-27', '2026-11-27']);
      expect(ledger.syncTransactions).toHaveBeenCalledWith(['t1', 't2', 't3']);
    });

    it('parcelado grava a compra com data e total próprios, e as parcelas apontam para ela', async () => {
      await service.createTransactionFromAi({
        ...base,
        amount: 100,
        recurrenceType: 'parcelado',
        installments: 3,
      });

      const [purchase] = prisma.installmentPurchase.create.mock.calls.map(([arg]: any) => arg.data);
      const rows = created();
      expect(purchase).toMatchObject({ totalAmount: 100, installmentCount: 3 });
      expect(purchase.id).toBe(rows[0].seriesId);
      expect(rows.every((r: any) => r.purchaseId === purchase.id)).toBe(true);
      // O fato de todas as parcelas é a compra, não a data de cada uma.
      expect(rows.map((r: any) => r.eventDate.toISOString().slice(0, 10))).toEqual([
        '2026-09-27',
        '2026-09-27',
        '2026-09-27',
      ]);
    });

    it('"gastei" à vista em conta comum nasce pago; "vence" fica em aberto', async () => {
      await service.createTransactionFromAi({ ...base, amount: 50, settle: true });
      expect(prisma.transactionSettlement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ amount: 50, origin: 'whatsapp', kind: 'payment' }),
        }),
      );

      prisma.transactionSettlement.create.mockClear();
      await service.createTransactionFromAi({
        ...base,
        idempotencyKey: 'job-10',
        amount: 50,
        settle: false,
      });
      expect(prisma.transactionSettlement.create).not.toHaveBeenCalled();
    });

    it('fixo repete o valor na frequência pedida', async () => {
      await service.createTransactionFromAi({
        ...base,
        amount: 55,
        recurrenceType: 'fixo',
        recurrenceFrequency: 'bimonthly',
        recurrenceMonths: 3,
      });

      const rows = created();
      expect(rows.map((r: any) => r.amount)).toEqual([55, 55, 55]);
      expect(rows[0]).toMatchObject({ recurrenceType: 'fixo', recurrenceFrequency: 'bimonthly' });
      expect(dates(rows)).toEqual(['2026-09-27', '2026-11-27', '2027-01-27']);
    });

    // A chave é única no banco: repetida em cada parcela, a 2ª linha estourava.
    it('grava a chave de idempotência e a extração só na 1ª ocorrência', async () => {
      await service.createTransactionFromAi({
        ...base,
        amount: 100,
        recurrenceType: 'parcelado',
        installments: 2,
        aiExtractedTransactionId: 'ext1',
      });

      const rows = created();
      expect(rows[0].idempotencyKey).toBe('job-9');
      expect(rows[1].idempotencyKey).toBeUndefined();
      expect(prisma.aiExtractedTransaction.update).toHaveBeenCalledWith({
        where: { id: 'ext1' },
        data: { transactionId: 't1', status: 'confirmed' },
      });
    });

    it('reentrega com a mesma chave devolve a série existente sem criar outra', async () => {
      prisma.transaction.findUnique.mockResolvedValue({
        id: 't1',
        userId: 'u1',
        accountId: 'a1',
        status: 'confirmed',
        seriesId: 's1',
      });
      prisma.transaction.findMany = jest.fn().mockResolvedValue([{ id: 't1' }, { id: 't2' }]);

      const result = await service.createTransactionFromAi({
        ...base,
        amount: 100,
        recurrenceType: 'parcelado',
        installments: 2,
      });

      expect(result).toMatchObject({ id: 't1', idempotent: true });
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(ledger.syncTransactions).toHaveBeenCalledWith(['t1', 't2']);
    });

    it('parcelado sem número de parcelas é recusado', async () => {
      await expect(
        service.createTransactionFromAi({ ...base, amount: 100, recurrenceType: 'parcelado' }),
      ).rejects.toThrow('Número de parcelas inválido');
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });
  });

  describe('createTransactionFromAi (idempotência)', () => {
    const dto = {
      userId: 'u1',
      accountId: 'a1',
      type: 'expense',
      amount: 47.5,
      description: 'mercado',
      transactionDate: '2026-09-05',
      source: 'whatsapp',
      idempotencyKey: 'job-1',
    } as any;

    beforeEach(() => {
      prisma.account.findUnique.mockResolvedValue({ id: 'a1', userId: 'u1', isActive: true });
    });

    it('devolve o lançamento existente sem criar outro quando a chave já foi usada', async () => {
      prisma.transaction.findUnique.mockResolvedValue({ id: 't1', userId: 'u1', amount: 47.5 });

      const result = await service.createTransactionFromAi(dto);

      expect(result).toMatchObject({ id: 't1', idempotent: true });
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    // O cenário que a idempotência cobre: o commit passou e o processo morreu
    // antes do recálculo. A reentrega caía no retorno antecipado, e o saldo
    // ficava defasado até outro lançamento tocar a conta.
    it('recalcula o saldo também quando devolve o lançamento já existente', async () => {
      prisma.transaction.findUnique.mockResolvedValue({
        id: 't1',
        userId: 'u1',
        accountId: 'a1',
        status: 'confirmed',
      });
      const accounts = { recalculateBalance: jest.fn() };
      service = new InternalService(prisma as any, accounts as any, access as any, ledger as any);

      await service.createTransactionFromAi(dto);

      expect(accounts.recalculateBalance).toHaveBeenCalledWith('a1');
      // A fatura do cartão também é garantida na reentrega.
      expect(ledger.syncTransactions).toHaveBeenCalledWith(['t1']);
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });

    it('recalcula o saldo quando a corrida no unique devolve o lançamento do outro worker', async () => {
      prisma.transaction.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 't1', userId: 'u1', accountId: 'a1', status: 'confirmed' });
      prisma.transaction.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '5' }),
      );
      const accounts = { recalculateBalance: jest.fn() };
      service = new InternalService(prisma as any, accounts as any, access as any, ledger as any);

      await service.createTransactionFromAi(dto);

      expect(accounts.recalculateBalance).toHaveBeenCalledWith('a1');
    });

    it('não recalcula o saldo de lançamento existente que foi cancelado', async () => {
      prisma.transaction.findUnique.mockResolvedValue({
        id: 't1',
        userId: 'u1',
        accountId: 'a1',
        status: 'cancelled',
      });
      const accounts = { recalculateBalance: jest.fn() };
      service = new InternalService(prisma as any, accounts as any, access as any, ledger as any);

      await service.createTransactionFromAi(dto);

      expect(accounts.recalculateBalance).not.toHaveBeenCalled();
    });

    it('grava a chave e a origem whatsapp ao criar', async () => {
      prisma.transaction.findUnique.mockResolvedValue(null);
      prisma.transaction.create.mockResolvedValue({
        id: 't1',
        accountId: 'a1',
        status: 'confirmed',
      });

      const accounts = { recalculateBalance: jest.fn() };
      service = new InternalService(prisma as any, accounts as any, access as any, ledger as any);

      const result = await service.createTransactionFromAi(dto);

      expect(result).toEqual({ id: 't1', accountId: 'a1', status: 'confirmed' });
      expect(prisma.transaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ idempotencyKey: 'job-1', source: 'whatsapp' }),
        }),
      );
      expect(accounts.recalculateBalance).toHaveBeenCalledWith('a1');
    });

    it('trata corrida no unique (P2002) devolvendo o lançamento já criado', async () => {
      prisma.transaction.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 't-existente', userId: 'u1' });
      prisma.transaction.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: '5',
        }),
      );

      const result = await service.createTransactionFromAi(dto);

      expect(result).toMatchObject({ id: 't-existente', idempotent: true });
    });

    // A chave é única no banco inteiro, mas a busca não olhava o dono: numa
    // colisão entre contas, o segundo usuário recebia o lançamento do primeiro.
    it('recusa com 409 a chave que já pertence a outro usuário, sem devolver o lançamento', async () => {
      prisma.transaction.findUnique.mockResolvedValue({
        id: 't-de-outro',
        userId: 'u2',
        amount: 999,
        description: 'lançamento de outra conta',
      });

      const tentativa = service.createTransactionFromAi(dto);

      await expect(tentativa).rejects.toBeInstanceOf(ConflictException);
      await expect(tentativa).rejects.toMatchObject({
        response: expect.not.objectContaining({ id: 't-de-outro' }),
      });
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });

    it('recusa com 409 também quando a colisão aparece na corrida do unique', async () => {
      prisma.transaction.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 't-de-outro', userId: 'u2' });
      prisma.transaction.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: '5',
        }),
      );

      await expect(service.createTransactionFromAi(dto)).rejects.toBeInstanceOf(ConflictException);
    });

    it('grava lançamento e extração na mesma transação de banco', async () => {
      prisma.transaction.findUnique.mockResolvedValue(null);
      prisma.transaction.create.mockResolvedValue({
        id: 't1',
        accountId: 'a1',
        status: 'confirmed',
      });
      const accounts = { recalculateBalance: jest.fn() };
      service = new InternalService(prisma as any, accounts as any, access as any, ledger as any);

      await service.createTransactionFromAi({
        ...dto,
        aiExtractedTransactionId: 'ext1',
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.aiExtractedTransaction.update).toHaveBeenCalledWith({
        where: { id: 'ext1' },
        data: { transactionId: 't1', status: 'confirmed' },
      });
    });
  });

  describe('recordEvent (message) — concorrência', () => {
    const dto = {
      eventType: 'message',
      phone: '+5541999999999',
      direction: 'inbound',
      content: 'gastei 50',
    } as any;

    it('trata corrida ao criar o contato (P2002) em vez de estourar 500', async () => {
      // `upsert` não é atômico: duas primeiras mensagens do mesmo número
      // chegando juntas faziam as duas tentarem o INSERT.
      prisma.whatsappContact.upsert.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: '5',
        }),
      );
      prisma.whatsappContact.findUnique.mockResolvedValue({ id: 'contact1', userId: 'u1' });
      prisma.aiConversation.findFirst.mockResolvedValue({ id: 'conv1' });
      prisma.aiConversation.update.mockResolvedValue({ id: 'conv1' });
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg1', conversationId: 'conv1' });

      const result = await service.recordEvent(dto);

      expect(result).toEqual({ id: 'msg1', conversationId: 'conv1' });
      expect(prisma.whatsappContact.findUnique).toHaveBeenCalledWith({
        where: { phoneNumber: '+5541999999999' },
      });
    });

    it('propaga erro que não seja corrida no unique do contato', async () => {
      prisma.whatsappContact.upsert.mockRejectedValue(new Error('banco fora'));

      await expect(service.recordEvent(dto)).rejects.toThrow('banco fora');
    });

    it('resolve a conversa travando a linha do contato', async () => {
      // Sem a trava, dois requests concorrentes criavam duas conversas ativas
      // e o histórico da IA ficava partido entre elas.
      prisma.whatsappContact.upsert.mockResolvedValue({ id: 'contact1', userId: 'u1' });
      prisma.aiConversation.findFirst.mockResolvedValue(null);
      prisma.aiConversation.create.mockResolvedValue({ id: 'conv1' });
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg1', conversationId: 'conv1' });

      await service.recordEvent(dto);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const [fragmentos, ...valores] = prisma.$queryRaw.mock.calls[0];
      expect(fragmentos.join('?')).toContain('FOR UPDATE');
      expect(valores).toEqual(['contact1']); // parametrizado, não interpolado
    });

    it('trava antes de decidir se cria a conversa', async () => {
      const ordem: string[] = [];
      prisma.whatsappContact.upsert.mockResolvedValue({ id: 'contact1', userId: 'u1' });
      prisma.$queryRaw.mockImplementation(async () => {
        ordem.push('lock');
        return [];
      });
      prisma.aiConversation.findFirst.mockImplementation(async () => {
        ordem.push('findFirst');
        return null;
      });
      prisma.aiConversation.create.mockImplementation(async () => {
        ordem.push('create');
        return { id: 'conv1' };
      });
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg1', conversationId: 'conv1' });

      await service.recordEvent(dto);

      expect(ordem).toEqual(['lock', 'findFirst', 'create']);
    });
  });

  describe('recordEvent (extraction)', () => {
    const dto = {
      eventType: 'extraction',
      userId: 'u1',
      rawInput: 'gastei 47,50 no mercado',
      extractedPayload: { amount: 47.5 },
      confidence: 0.9,
      status: 'confirmed',
      sourceMessageId: 'ai-msg-1',
      idempotencyKey: 'job-1',
    } as any;

    it('cria a extração e grava a chave de idempotência', async () => {
      prisma.aiExtractedTransaction.findUnique.mockResolvedValue(null);
      prisma.aiExtractedTransaction.create.mockResolvedValue({ id: 'ext1' });

      const result = await service.recordEvent(dto);

      expect(result).toEqual({ id: 'ext1' });
      expect(prisma.aiExtractedTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ idempotencyKey: 'job-1', sourceMessageId: 'ai-msg-1' }),
      });
    });

    it('devolve a extração existente sem criar outra quando a chave já foi usada', async () => {
      prisma.aiExtractedTransaction.findUnique.mockResolvedValue({ id: 'ext1', userId: 'u1' });

      const result = await service.recordEvent(dto);

      expect(result).toEqual({ id: 'ext1', duplicate: true });
      expect(prisma.aiExtractedTransaction.create).not.toHaveBeenCalled();
    });

    it('trata corrida no unique (P2002) devolvendo a extração já criada', async () => {
      prisma.aiExtractedTransaction.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'ext-existente', userId: 'u1' });
      prisma.aiExtractedTransaction.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: '5',
        }),
      );

      const result = await service.recordEvent(dto);

      expect(result).toEqual({ id: 'ext-existente', duplicate: true });
    });

    it('recusa com 409 a extração de outro usuário, em vez de devolver o id dela', async () => {
      // Devolver o id levaria o agente a vincular depois uma extração que não é
      // do usuário dele.
      prisma.aiExtractedTransaction.findUnique.mockResolvedValue({
        id: 'ext-de-outro',
        userId: 'u2',
      });

      await expect(service.recordEvent(dto)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.aiExtractedTransaction.create).not.toHaveBeenCalled();
    });

    it('recusa com 409 a extração de outro usuário também na corrida do unique', async () => {
      prisma.aiExtractedTransaction.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'ext-de-outro', userId: 'u2' });
      prisma.aiExtractedTransaction.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: '5',
        }),
      );

      await expect(service.recordEvent(dto)).rejects.toBeInstanceOf(ConflictException);
    });

    it('sem chave de idempotência, cria normalmente (modo legado)', async () => {
      prisma.aiExtractedTransaction.create.mockResolvedValue({ id: 'ext2' });

      const result = await service.recordEvent({ ...dto, idempotencyKey: undefined });

      expect(result).toEqual({ id: 'ext2' });
      expect(prisma.aiExtractedTransaction.findUnique).not.toHaveBeenCalled();
    });

    it('exige os campos obrigatórios da extração', async () => {
      await expect(
        service.recordEvent({ eventType: 'extraction', userId: 'u1' } as any),
      ).rejects.toThrow('userId, rawInput, extractedPayload e confidence');
    });
  });

  describe('recordEvent (message)', () => {
    it('cria conversa quando não existe e grava a mensagem', async () => {
      prisma.whatsappContact.upsert.mockResolvedValue({ id: 'contact1', userId: 'u1' });
      prisma.aiConversation.findFirst.mockResolvedValue(null);
      prisma.aiConversation.create.mockResolvedValue({ id: 'conv1' });
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg1', conversationId: 'conv1' });

      const result = await service.recordEvent({
        eventType: 'message',
        phone: '+5511999999999',
        direction: 'inbound' as any,
        content: 'gastei 50',
      } as any);

      expect(prisma.aiConversation.create).toHaveBeenCalled();
      expect(result).toEqual({ id: 'msg1', conversationId: 'conv1' });
    });

    it('conversa de número revogado não é atribuída ao dono anterior', async () => {
      prisma.whatsappContact.upsert.mockResolvedValue({
        id: 'contact1',
        userId: 'dono-anterior',
        isVerified: false,
        revokedAt: new Date(),
      });
      prisma.aiConversation.findFirst.mockResolvedValue(null);
      prisma.aiConversation.create.mockResolvedValue({ id: 'conv1' });
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg1', conversationId: 'conv1' });

      await service.recordEvent({
        eventType: 'message',
        phone: '+5511999999999',
        direction: 'inbound' as any,
        content: 'oi',
      } as any);

      expect(prisma.aiConversation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ whatsappContactId: 'contact1', userId: null }),
      });
    });

    it('reusa a conversa ativa existente', async () => {
      prisma.whatsappContact.upsert.mockResolvedValue({ id: 'contact1', userId: 'u1' });
      prisma.aiConversation.findFirst.mockResolvedValue({ id: 'convX' });
      prisma.aiConversation.update.mockResolvedValue({ id: 'convX' });
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg2', conversationId: 'convX' });

      const result = await service.recordEvent({
        eventType: 'message',
        phone: '+5511999999999',
        direction: 'inbound' as any,
        content: 'oi',
      } as any);

      expect(prisma.aiConversation.create).not.toHaveBeenCalled();
      expect(prisma.aiConversation.update).toHaveBeenCalled();
      expect(result).toEqual({ id: 'msg2', conversationId: 'convX' });
    });

    it('é idempotente por providerMessageId (não duplica)', async () => {
      prisma.aiMessage.findUnique.mockResolvedValue({ id: 'existing', conversationId: 'conv1' });

      const result = await service.recordEvent({
        eventType: 'message',
        phone: '+5511999999999',
        direction: 'inbound' as any,
        content: 'gastei 50',
        metadata: { messageId: 'm1' },
      } as any);

      expect(prisma.aiMessage.findUnique).toHaveBeenCalledWith({
        where: { providerMessageId: 'm1' },
      });
      expect(prisma.aiMessage.create).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'existing', conversationId: 'conv1', duplicate: true });
    });

    it('grava providerMessageId/providerTimestamp ao criar', async () => {
      prisma.aiMessage.findUnique.mockResolvedValue(null);
      prisma.whatsappContact.upsert.mockResolvedValue({ id: 'contact1', userId: 'u1' });
      prisma.aiConversation.findFirst.mockResolvedValue({ id: 'conv1' });
      prisma.aiConversation.update.mockResolvedValue({ id: 'conv1' });
      prisma.aiMessage.create.mockResolvedValue({ id: 'msg1', conversationId: 'conv1' });

      await service.recordEvent({
        eventType: 'message',
        phone: '+5511999999999',
        direction: 'inbound' as any,
        content: 'gastei 50',
        metadata: { messageId: 'm1', timestamp: 1700000000 },
      } as any);

      const createArg = prisma.aiMessage.create.mock.calls[0][0];
      expect(createArg.data.providerMessageId).toBe('m1');
      expect(createArg.data.providerTimestamp).toEqual(new Date(1700000000 * 1000));
    });

    it('trata corrida no unique (P2002) devolvendo a mensagem existente', async () => {
      prisma.aiMessage.findUnique
        .mockResolvedValueOnce(null) // checagem inicial
        .mockResolvedValueOnce({ id: 'existing', conversationId: 'conv1' }); // após P2002
      prisma.whatsappContact.upsert.mockResolvedValue({ id: 'contact1', userId: 'u1' });
      prisma.aiConversation.findFirst.mockResolvedValue({ id: 'conv1' });
      prisma.aiConversation.update.mockResolvedValue({ id: 'conv1' });
      prisma.aiMessage.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      const result = await service.recordEvent({
        eventType: 'message',
        phone: '+5511999999999',
        direction: 'inbound' as any,
        content: 'gastei 50',
        metadata: { messageId: 'm1' },
      } as any);

      expect(result).toEqual({ id: 'existing', conversationId: 'conv1', duplicate: true });
    });
  });
});
