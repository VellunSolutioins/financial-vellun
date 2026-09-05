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
    transaction: { create: jest.fn(), findUnique: jest.fn() },
    aiExtractedTransaction: { update: jest.fn(), create: jest.fn(), findUnique: jest.fn() },
  };
  // `$transaction(fn)` executa o callback com o próprio mock como client.
  mock.$transaction = jest.fn(async (fn: any) => fn(mock));
  return mock;
}

describe('InternalService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: InternalService;

  let access: { canUseProduct: jest.Mock; isEnforced: jest.Mock };

  beforeEach(() => {
    prisma = createPrismaMock();
    access = {
      canUseProduct: jest.fn().mockResolvedValue({ allowed: true }),
      isEnforced: jest.fn().mockReturnValue(true),
    };
    service = new InternalService(prisma as any, {} as any, access as any);
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
      prisma.account.findMany.mockResolvedValue([{ id: 'a1' }]);

      const result = await service.listAccounts('u1');

      expect(access.canUseProduct).toHaveBeenCalledWith('u1');
      expect(result).toEqual([{ id: 'a1' }]);
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
      prisma.account.findMany.mockResolvedValue([{ id: 'a1' }]);

      const result = await service.listAccounts('u1');

      expect(result).toEqual([{ id: 'a1' }]);
      expect(access.canUseProduct).not.toHaveBeenCalled();
    });

    it('createTransactionFromAi rejeita conta de outro usuário (userId manipulado)', async () => {
      access.canUseProduct.mockResolvedValue({ allowed: true });
      prisma.account.findUnique.mockResolvedValue({ id: 'a1', userId: 'outro' });

      await expect(
        service.createTransactionFromAi({ userId: 'u1', accountId: 'a1' } as any),
      ).rejects.toThrow('Conta inválida para o usuário');
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });

    it('createTransactionFromAi rejeita categoria de outro usuário', async () => {
      prisma.account.findUnique.mockResolvedValue({ id: 'a1', userId: 'u1' });
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
      prisma.account.findUnique.mockResolvedValue({ id: 'a1', userId: 'u1' });
    });

    it('devolve o lançamento existente sem criar outro quando a chave já foi usada', async () => {
      prisma.transaction.findUnique.mockResolvedValue({ id: 't1', amount: 47.5 });

      const result = await service.createTransactionFromAi(dto);

      expect(result).toMatchObject({ id: 't1', idempotent: true });
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('grava a chave e a origem whatsapp ao criar', async () => {
      prisma.transaction.findUnique.mockResolvedValue(null);
      prisma.transaction.create.mockResolvedValue({ id: 't1', status: 'confirmed' });

      const accounts = { recalculateBalance: jest.fn() };
      service = new InternalService(prisma as any, accounts as any, access as any);

      const result = await service.createTransactionFromAi(dto);

      expect(result).toEqual({ id: 't1', status: 'confirmed' });
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
        .mockResolvedValueOnce({ id: 't-existente' });
      prisma.transaction.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: '5',
        }),
      );

      const result = await service.createTransactionFromAi(dto);

      expect(result).toMatchObject({ id: 't-existente', idempotent: true });
    });

    it('grava lançamento e extração na mesma transação de banco', async () => {
      prisma.transaction.findUnique.mockResolvedValue(null);
      prisma.transaction.create.mockResolvedValue({ id: 't1', status: 'pending' });

      await service.createTransactionFromAi({
        ...dto,
        status: 'pending',
        aiExtractedTransactionId: 'ext1',
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.aiExtractedTransaction.update).toHaveBeenCalledWith({
        where: { id: 'ext1' },
        data: { transactionId: 't1', status: 'confirmed' },
      });
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
      prisma.aiExtractedTransaction.findUnique.mockResolvedValue({ id: 'ext1' });

      const result = await service.recordEvent(dto);

      expect(result).toEqual({ id: 'ext1', duplicate: true });
      expect(prisma.aiExtractedTransaction.create).not.toHaveBeenCalled();
    });

    it('trata corrida no unique (P2002) devolvendo a extração já criada', async () => {
      prisma.aiExtractedTransaction.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'ext-existente' });
      prisma.aiExtractedTransaction.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: '5',
        }),
      );

      const result = await service.recordEvent(dto);

      expect(result).toEqual({ id: 'ext-existente', duplicate: true });
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
