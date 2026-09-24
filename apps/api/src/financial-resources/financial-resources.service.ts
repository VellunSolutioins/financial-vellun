import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { REGULAR_ACCOUNT_WHERE } from '../accounts/account-types';
import { cardNeedsSetup } from '../credit-cards/credit-cards.service';

/**
 * Contas e cartões do usuário, separados, para os seletores de lançamento.
 * O lançamento continua apontando para uma `Account`: no cartão, o valor a
 * gravar é o `accountId` da conta interna dele.
 */
@Injectable()
export class FinancialResourcesService {
  constructor(private prisma: PrismaService) {}

  async list(userId: string) {
    const [accounts, cards] = await Promise.all([
      this.prisma.account.findMany({
        where: { userId, isActive: true, ...REGULAR_ACCOUNT_WHERE },
        select: { id: true, name: true, type: true, currentBalance: true },
        orderBy: { createdAt: 'asc' },
      }),
      // Arquivados vêm junto (com `isActive: false`): quem edita um lançamento
      // antigo precisa ver o cartão dele, mesmo sem poder escolhê-lo para compra nova.
      this.prisma.creditCard.findMany({
        where: { account: { userId } },
        include: { account: { select: { id: true, name: true, isActive: true } } },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      }),
    ]);

    return {
      accounts: accounts.map((a) => ({ ...a, currentBalance: Number(a.currentBalance) })),
      cards: cards.map((c) => ({
        id: c.id,
        accountId: c.account.id,
        name: c.account.name,
        brand: c.brand,
        color: c.color,
        isPrimary: c.isPrimary,
        needsSetup: cardNeedsSetup(c),
        isActive: c.account.isActive,
      })),
    };
  }
}
