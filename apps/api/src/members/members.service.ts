import { randomUUID } from 'crypto';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionService } from '../billing/services/subscription.service';
import { SubscriptionAccessService } from '../billing/services/subscription-access.service';

const INVITE_TTL_DAYS = 7;

@Injectable()
export class MembersService {
  constructor(
    private prisma: PrismaService,
    private subscriptions: SubscriptionService,
    private subscriptionAccess: SubscriptionAccessService,
  ) {}

  /** Garante que quem chama é o dono do plano (nunca um membro convidado). */
  private async requireOwner(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.householdOwnerId) {
      throw new ForbiddenException('Só o dono do plano pode gerenciar membros.');
    }
    return user;
  }

  async listMembers(dataOwnerId: string) {
    const [owner, members] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: dataOwnerId },
        select: { id: true, name: true, email: true },
      }),
      this.prisma.user.findMany({
        where: { householdOwnerId: dataOwnerId },
        select: { id: true, name: true, email: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const subscription = await this.subscriptions.getUserSubscription(dataOwnerId);

    return {
      owner: { ...owner, isOwner: true },
      members: members.map((m) => ({ ...m, isOwner: false })),
      maxMembers: subscription?.plan?.maxMembers ?? 1,
    };
  }

  async listInvites(ownerId: string, webUrl: string) {
    await this.requireOwner(ownerId);
    const invites = await this.prisma.memberInvite.findMany({
      where: { ownerId, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
    return invites.map((invite) => ({ ...invite, inviteUrl: `${webUrl}/convite/${invite.token}` }));
  }

  async invite(ownerId: string, email: string, webUrl: string) {
    await this.requireOwner(ownerId);

    const subscription = await this.subscriptions.getUserSubscription(ownerId);
    const access = this.subscriptionAccess.evaluate(subscription ?? null);
    if (this.subscriptionAccess.isEnforced() && !access.allowed) {
      throw new BadRequestException('Sua assinatura não está ativa.');
    }

    const maxMembers = subscription?.plan?.maxMembers ?? 1;
    const [memberCount, pendingCount] = await Promise.all([
      this.prisma.user.count({ where: { householdOwnerId: ownerId } }),
      this.prisma.memberInvite.count({ where: { ownerId, status: 'pending' } }),
    ]);
    // +1 conta o próprio dono.
    if (1 + memberCount + pendingCount >= maxMembers) {
      throw new BadRequestException(
        `Seu plano permite até ${maxMembers} pessoa${maxMembers > 1 ? 's' : ''}.`,
      );
    }

    const existingUser = await this.prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      throw new BadRequestException('Já existe uma conta com esse email.');
    }

    const existingInvite = await this.prisma.memberInvite.findFirst({
      where: { ownerId, email, status: 'pending' },
    });
    if (existingInvite) {
      throw new BadRequestException('Já existe um convite pendente para esse email.');
    }

    const invite = await this.prisma.memberInvite.create({
      data: {
        ownerId,
        email,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    });

    return { ...invite, inviteUrl: `${webUrl}/convite/${invite.token}` };
  }

  async revokeInvite(ownerId: string, inviteId: string) {
    await this.requireOwner(ownerId);
    const invite = await this.prisma.memberInvite.findUnique({ where: { id: inviteId } });
    if (!invite || invite.ownerId !== ownerId) {
      throw new NotFoundException('Convite não encontrado');
    }
    await this.prisma.memberInvite.update({
      where: { id: inviteId },
      data: { status: 'revoked' },
    });
    return { message: 'Convite cancelado' };
  }

  async removeMember(ownerId: string, memberId: string) {
    await this.requireOwner(ownerId);
    const member = await this.prisma.user.findUnique({ where: { id: memberId } });
    if (!member || member.householdOwnerId !== ownerId) {
      throw new NotFoundException('Membro não encontrado');
    }
    // Libera o e-mail para um novo convite. Não dá pra excluir o usuário: os
    // lançamentos que ele criou referenciam createdByUserId em cascade, e
    // excluir apagaria esse histórico junto. Login antigo fica inutilizável
    // (senha aleatória) já que o e-mail original não existe mais na conta.
    await this.prisma.user.update({
      where: { id: memberId },
      data: {
        householdOwnerId: null,
        email: `removed+${memberId}@${member.email.split('@')[1] ?? 'invalid.local'}`,
        passwordHash: await bcrypt.hash(randomUUID(), 12),
      },
    });
    return { message: 'Membro removido' };
  }

  /** Dados públicos do convite, para a tela de aceite pré-preencher o email. */
  async getInviteByToken(token: string) {
    const invite = await this.prisma.memberInvite.findUnique({
      where: { token },
      include: { owner: { select: { name: true } } },
    });
    if (!invite || invite.status !== 'pending' || invite.expiresAt < new Date()) {
      throw new NotFoundException('Convite inválido ou expirado');
    }
    return { email: invite.email, ownerName: invite.owner.name };
  }

  async acceptInvite(token: string, name: string, password: string) {
    const invite = await this.prisma.memberInvite.findUnique({ where: { token } });
    if (!invite || invite.status !== 'pending' || invite.expiresAt < new Date()) {
      throw new NotFoundException('Convite inválido ou expirado');
    }

    const existingUser = await this.prisma.user.findUnique({ where: { email: invite.email } });
    if (existingUser) {
      throw new BadRequestException('Já existe uma conta com esse email.');
    }

    const owner = await this.prisma.user.findUniqueOrThrow({ where: { id: invite.ownerId } });
    const passwordHash = await bcrypt.hash(password, 12);

    const user = await this.prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          name,
          email: invite.email,
          passwordHash,
          profileType: owner.profileType,
          householdOwnerId: owner.id,
        },
      });

      await tx.memberInvite.update({
        where: { id: invite.id },
        data: { status: 'accepted', acceptedAt: new Date() },
      });

      return createdUser;
    });

    return user;
  }
}
