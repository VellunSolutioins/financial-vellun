import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { REGULAR_ACCOUNT_WHERE } from '../accounts/account-types';
import { cardNeedsSetup } from '../credit-cards/card-setup';

import { SetPreferredDto } from './dto/set-preferred.dto';

/**
 * Contas e cartões do usuário, separados, para os seletores de lançamento.
 * O lançamento continua apontando para uma `Account`: no cartão, o valor a
 * gravar é o `accountId` da conta interna dele. O preferencial (um só, conta
 * ou cartão) é o que o formulário de novo lançamento traz selecionado.
 */
@Injectable()
export class FinancialResourcesService {
  constructor(private prisma: PrismaService) {}

  async list(userId: string) {
    const [accounts, cards, user] = await Promise.all([
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
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { preferredAccountId: true },
      }),
    ]);

    // Só vale se o recurso ainda recebe lançamento (a limpeza ao desativar ou
    // arquivar já cuida disso; aqui é defesa).
    const candidate = user?.preferredAccountId ?? null;
    const usable =
      accounts.some((a) => a.id === candidate) ||
      cards.some((c) => c.account.id === candidate && c.account.isActive);
    const preferredAccountId = usable ? candidate : null;

    return {
      preferredAccountId,
      accounts: accounts.map((a) => ({
        ...a,
        currentBalance: Number(a.currentBalance),
        isPreferred: a.id === preferredAccountId,
      })),
      cards: cards.map((c) => ({
        id: c.id,
        accountId: c.account.id,
        name: c.account.name,
        brand: c.brand,
        color: c.color,
        isPreferred: c.account.id === preferredAccountId,
        needsSetup: cardNeedsSetup(c),
        isActive: c.account.isActive,
      })),
    };
  }

  /**
   * Define (ou limpa, sem `accountId` nem `cardId`) o recurso preferencial. Só
   * conta comum ativa ou cartão não arquivado do próprio usuário.
   */
  async setPreferred(userId: string, dto: SetPreferredDto) {
    if (dto.accountId && dto.cardId) {
      throw new BadRequestException('Informe uma conta ou um cartão, não os dois');
    }

    let preferredAccountId: string | null = null;
    if (dto.accountId) {
      const account = await this.prisma.account.findFirst({
        where: { id: dto.accountId, userId, isActive: true, ...REGULAR_ACCOUNT_WHERE },
        select: { id: true },
      });
      if (!account) throw new BadRequestException('Conta inválida');
      preferredAccountId = account.id;
    } else if (dto.cardId) {
      const card = await this.prisma.creditCard.findFirst({
        where: { id: dto.cardId, account: { userId, isActive: true } },
        select: { accountId: true },
      });
      if (!card) throw new BadRequestException('Cartão inválido');
      preferredAccountId = card.accountId;
    }

    await this.prisma.user.update({ where: { id: userId }, data: { preferredAccountId } });
    return this.list(userId);
  }
}
