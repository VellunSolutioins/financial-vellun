import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { SubscriptionAccessService } from '../billing/services/subscription-access.service';
import { SubscriptionRequiredException } from '../billing/subscription-required.exception';
import { CreateAiTransactionDto } from './dto/create-ai-transaction.dto';
import { AiEventDto } from './dto/ai-event.dto';
import { normalizePhone } from '../common/phone.util';
import { parseDateOnly } from '../common/date.util';

@Injectable()
export class InternalService {
  constructor(
    private prisma: PrismaService,
    private accountsService: AccountsService,
    private subscriptionAccess: SubscriptionAccessService,
  ) {}

  /**
   * Garante que o usuário (já resolvido por vínculo, nunca arbitrário) tem
   * direito de uso antes de qualquer operação de dados/criação via IA.
   */
  private async assertCanUseProduct(userId: string) {
    if (!this.subscriptionAccess.isEnforced()) return;
    const access = await this.subscriptionAccess.canUseProduct(userId);
    if (!access.allowed) {
      throw new SubscriptionRequiredException();
    }
  }

  /** Busca um usuário pelo número de telefone vinculado no WhatsApp. */
  async findContactByPhone(phone: string) {
    const contact = await this.prisma.whatsappContact.findUnique({
      where: { phoneNumber: normalizePhone(phone) },
      include: { user: true },
    });

    if (!contact || !contact.user) {
      throw new NotFoundException('Contato não vinculado a uma conta');
    }

    return {
      userId: contact.user.id,
      name: contact.user.name,
      profileType: contact.user.profileType,
      isVerified: contact.isVerified,
    };
  }

  /** Lista as categorias disponíveis para o usuário (próprias + padrão do seu perfil). */
  async listCategories(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuário não encontrado');
    await this.assertCanUseProduct(userId);

    return this.prisma.category.findMany({
      where: {
        profileType: user.profileType,
        OR: [{ userId }, { isDefault: true, userId: null }],
      },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  }

  /**
   * Reporta o direito de uso do usuário para o canal de IA decidir antes de
   * qualquer operação paga. **Não lança** — apenas informa.
   */
  async getSubscriptionAccess(userId: string) {
    const access = await this.subscriptionAccess.canUseProduct(userId);
    // Respeita a feature flag de rollout: o canal de IA confia nesta resposta.
    const allowed = this.subscriptionAccess.isEnforced() ? access.allowed : true;
    return { canUseProduct: allowed, reason: access.reason, status: access.status };
  }

  /** Lista as contas ativas do usuário. */
  async listAccounts(userId: string) {
    await this.assertCanUseProduct(userId);
    return this.prisma.account.findMany({
      where: { userId, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Lista as mensagens recentes da conversa ativa de um contato (ordem
   * cronológica), para uso como contexto pela IA. Retorna vazio quando o
   * contato ou a conversa ativa não existem.
   */
  async listRecentMessagesByPhone(phone: string, limit = 15) {
    const take = Math.min(Math.max(limit, 1), 50);

    const contact = await this.prisma.whatsappContact.findUnique({
      where: { phoneNumber: normalizePhone(phone) },
    });
    if (!contact) {
      return { conversationId: null, messages: [] };
    }

    const conversation = await this.prisma.aiConversation.findFirst({
      where: { whatsappContactId: contact.id, status: 'active' },
      orderBy: { createdAt: 'desc' },
    });
    if (!conversation) {
      return { conversationId: null, messages: [] };
    }

    const messages = await this.prisma.aiMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        direction: true,
        content: true,
        metadata: true,
        createdAt: true,
      },
    });

    return {
      conversationId: conversation.id,
      messages: messages.reverse(),
    };
  }

  /** Cria um lançamento originado pela IA/WhatsApp e atualiza a rastreabilidade. */
  async createTransactionFromAi(dto: CreateAiTransactionDto) {
    await this.assertCanUseProduct(dto.userId);

    const account = await this.prisma.account.findUnique({ where: { id: dto.accountId } });
    if (!account || account.userId !== dto.userId) {
      throw new BadRequestException('Conta inválida para o usuário');
    }

    if (dto.categoryId) {
      const category = await this.prisma.category.findUnique({ where: { id: dto.categoryId } });
      if (!category || (category.userId !== null && category.userId !== dto.userId)) {
        throw new BadRequestException('Categoria inválida para o usuário');
      }
    }

    const transaction = await this.prisma.transaction.create({
      data: {
        userId: dto.userId,
        accountId: dto.accountId,
        categoryId: dto.categoryId,
        type: dto.type,
        amount: dto.amount,
        description: dto.description,
        transactionDate: parseDateOnly(dto.transactionDate),
        status: dto.status ?? 'confirmed',
        source: dto.source ?? 'ai',
        rawInput: dto.rawInput,
      },
      include: { category: true, account: true },
    });

    if (transaction.status === 'confirmed') {
      await this.accountsService.recalculateBalance(dto.accountId);
    }

    if (dto.aiExtractedTransactionId) {
      await this.prisma.aiExtractedTransaction.update({
        where: { id: dto.aiExtractedTransactionId },
        data: { transactionId: transaction.id, status: 'confirmed' },
      });
    }

    return transaction;
  }

  /** Persiste um evento de auditoria do agente de IA. */
  async recordEvent(dto: AiEventDto) {
    if (dto.eventType === 'message') {
      return this.recordMessage(dto);
    }
    return this.recordExtraction(dto);
  }

  private async recordMessage(dto: AiEventDto) {
    if (!dto.phone || !dto.direction || !dto.content) {
      throw new BadRequestException('phone, direction e content são obrigatórios para mensagens');
    }

    // Idempotência: o provedor pode reenviar o mesmo webhook. Se já temos a
    // mensagem com este providerMessageId, devolvemos a existente sem duplicar.
    const metadata = (dto.metadata ?? {}) as Record<string, unknown>;
    const providerMessageId =
      typeof metadata.messageId === 'string' ? metadata.messageId : undefined;
    const providerTimestamp =
      typeof metadata.timestamp === 'number' ? new Date(metadata.timestamp * 1000) : undefined;

    if (providerMessageId) {
      const existing = await this.prisma.aiMessage.findUnique({
        where: { providerMessageId },
      });
      if (existing) {
        return { id: existing.id, conversationId: existing.conversationId, duplicate: true };
      }
    }

    const contact = await this.prisma.whatsappContact.upsert({
      where: { phoneNumber: normalizePhone(dto.phone) },
      update: {},
      create: { phoneNumber: normalizePhone(dto.phone) },
    });

    let conversation = await this.prisma.aiConversation.findFirst({
      where: { whatsappContactId: contact.id, status: 'active' },
      orderBy: { createdAt: 'desc' },
    });

    if (!conversation) {
      conversation = await this.prisma.aiConversation.create({
        data: {
          whatsappContactId: contact.id,
          userId: contact.userId,
          status: 'active',
          lastMessageAt: new Date(),
        },
      });
    } else {
      await this.prisma.aiConversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      });
    }

    try {
      const message = await this.prisma.aiMessage.create({
        data: {
          conversationId: conversation.id,
          direction: dto.direction,
          content: dto.content,
          metadata: (dto.metadata as Prisma.InputJsonValue) ?? undefined,
          providerMessageId,
          providerTimestamp,
        },
      });
      return { id: message.id, conversationId: conversation.id };
    } catch (err) {
      // Corrida no unique providerMessageId: outro request criou primeiro.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        providerMessageId
      ) {
        const existing = await this.prisma.aiMessage.findUnique({
          where: { providerMessageId },
        });
        if (existing) {
          return { id: existing.id, conversationId: existing.conversationId, duplicate: true };
        }
      }
      throw err;
    }
  }

  private async recordExtraction(dto: AiEventDto) {
    if (!dto.userId || !dto.rawInput || dto.extractedPayload === undefined || dto.confidence === undefined) {
      throw new BadRequestException(
        'userId, rawInput, extractedPayload e confidence são obrigatórios para extrações',
      );
    }

    const extraction = await this.prisma.aiExtractedTransaction.create({
      data: {
        userId: dto.userId,
        rawInput: dto.rawInput,
        extractedPayload: dto.extractedPayload as Prisma.InputJsonValue,
        confidence: dto.confidence,
        status: dto.status ?? 'pending',
        transactionId: dto.transactionId,
        sourceMessageId: dto.sourceMessageId,
      },
    });

    return { id: extraction.id };
  }
}
