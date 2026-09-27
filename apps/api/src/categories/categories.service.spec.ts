import { ForbiddenException } from '@nestjs/common';

import { CategoriesService } from './categories.service';

function createService(category: Record<string, unknown> | null) {
  const tx = {
    transaction: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
    category: { delete: jest.fn().mockResolvedValue({ id: 'cat-1' }) },
  };
  const prisma = {
    category: { findUnique: jest.fn().mockResolvedValue(category) },
    $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  const service = new CategoriesService(prisma as any);
  return { prisma, tx, service };
}

describe('CategoriesService.remove', () => {
  it('exclui categoria com lançamentos, deixando-os sem categoria', async () => {
    const { tx, service } = createService({ id: 'cat-1', userId: 'user-1', isDefault: false });

    const result = await service.remove('user-1', 'cat-1');

    expect(tx.transaction.updateMany).toHaveBeenCalledWith({
      where: { categoryId: 'cat-1' },
      data: { categoryId: null },
    });
    expect(tx.category.delete).toHaveBeenCalledWith({ where: { id: 'cat-1' } });
    expect(result).toEqual({ id: 'cat-1', uncategorizedTransactions: 3 });
  });

  it('continua bloqueando categoria padrão', async () => {
    const { tx, service } = createService({ id: 'cat-1', userId: null, isDefault: true });

    await expect(service.remove('user-1', 'cat-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.transaction.updateMany).not.toHaveBeenCalled();
  });

  it('continua bloqueando categoria de outro usuário', async () => {
    const { tx, service } = createService({ id: 'cat-1', userId: 'user-2', isDefault: false });

    await expect(service.remove('user-1', 'cat-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.category.delete).not.toHaveBeenCalled();
  });
});
