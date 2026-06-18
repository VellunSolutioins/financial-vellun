import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { CreateAiTransactionDto } from './dto/create-ai-transaction.dto';
import { AiEventDto } from './dto/ai-event.dto';
import { normalizePhone } from '../common/phone.util';

@Injectable()
export class InternalService {
  constructor(
    private prisma: PrismaService,
    private accountsService: AccountsService,
  ) {}

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

    return this.prisma.category.findMany({
      where: {
        profileType: user.profileType,
        OR: [{ userId }, { isDefault: true, userId: null }],
      },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  }

  /** Lista as contas ativas do usuário. */
  async listAccounts(userId: string) {
    return this.prisma.account.findMany({
      where: { userId, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Cria um lançamento originado pela IA/WhatsApp e atualiza a rastreabilidade. */
  async createTransactionFromAi(dto: CreateAiTransactionDto) {
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
        transactionDate: new Date(dto.transactionDate),
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

    const message = await this.prisma.aiMessage.create({
      data: {
        conversationId: conversation.id,
        direction: dto.direction,
        content: dto.content,
        metadata: (dto.metadata as Prisma.InputJsonValue) ?? undefined,
      },
    });

    return { id: message.id, conversationId: conversation.id };
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
