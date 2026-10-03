import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { SubscriptionAccessService } from '../billing/services/subscription-access.service';
import { SubscriptionRequiredException } from '../billing/subscription-required.exception';
import { CreateAiTransactionDto } from './dto/create-ai-transaction.dto';
import { AiEventDto } from './dto/ai-event.dto';
import { normalizePhone } from '../common/phone.util';
import { isFutureDay, parseDateOnly } from '../common/date.util';
import { FINANCIAL_TX_OPTIONS, lockAccounts } from '../common/db';
import {
  assertAccountAcceptsEntries,
  assertAccountAcceptsType,
  assertInstallmentIsExpense,
} from '../transactions/transactions.service';
import { CardLedgerService } from '../credit-cards/card-ledger.service';
import { cardNeedsSetup } from '../credit-cards/card-setup';
import { writeEntrySeries } from '../transactions/entry-writer';

/** Vínculo que identifica o usuário: verificado e não revogado. */
function isLinked(contact: { userId: string | null; isVerified: boolean; revokedAt: Date | null }) {
  return contact.userId !== null && contact.isVerified && contact.revokedAt === null;
}

@Injectable()
export class InternalService {
  private readonly logger = new Logger(InternalService.name);

  constructor(
    private prisma: PrismaService,
    private accountsService: AccountsService,
    private subscriptionAccess: SubscriptionAccessService,
    private cardLedger: CardLedgerService = new CardLedgerService(prisma),
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

  /**
   * Usuário identificado pelo número de WhatsApp.
   *
   * Só um vínculo **verificado e ativo** identifica alguém: número apenas
   * declarado no cadastro, ou revogado numa troca de telefone, responde `404`
   * como não vinculado. `contactId` e `linkVersion` deixam o agente perceber
   * que o número mudou de dono entre uma pergunta e a resposta do usuário.
   */
  async findContactByPhone(phone: string) {
    const contact = await this.prisma.whatsappContact.findUnique({
      where: { phoneNumber: normalizePhone(phone) },
      include: { user: true },
    });

    if (!contact || !contact.user || !isLinked(contact)) {
      throw new NotFoundException('Contato não vinculado a uma conta');
    }

    return {
      userId: contact.user.id,
      name: contact.user.name,
      profileType: contact.user.profileType,
      isVerified: contact.isVerified,
      contactId: contact.id,
      linkVersion: contact.linkVersion,
    };
  }

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

  /**
   * Contas comuns e cartões ativos do usuário, marcados com `kind`. O `id` é
   * sempre o da `Account` — no cartão, a conta interna dele —, que é o que o
   * lançamento grava. Cartão arquivado não aparece: não recebe compra.
   *
   * `isPreferred` marca o recurso "Padrão nos lançamentos" (no máximo um), que
   * o agente usa quando a mensagem não cita conta nem cartão. `needsSetup`
   * marca o cartão sem fechamento/vencimento: a compra entra, mas sem fatura.
   */
  async listAccounts(userId: string) {
    await this.assertCanUseProduct(userId);
    const [accounts, user] = await Promise.all([
      this.prisma.account.findMany({
        where: { userId, isActive: true },
        include: {
          creditCard: {
            select: { id: true, closingDay: true, dueDay: true, invoiceTrackingStart: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { preferredAccountId: true } }),
    ]);
    const preferredAccountId = user?.preferredAccountId ?? null;
    return accounts.map(({ creditCard, ...account }) => ({
      ...account,
      kind: creditCard || account.type === 'credit_card' ? ('card' as const) : ('account' as const),
      cardId: creditCard?.id ?? null,
      isPreferred: account.id === preferredAccountId,
      needsSetup: creditCard ? cardNeedsSetup(creditCard) : false,
    }));
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

  /**
   * Cria um lançamento originado pela IA/WhatsApp e atualiza a rastreabilidade.
   *
   * Idempotente quando `idempotencyKey` é informado: a mesma chave sempre
   * devolve o mesmo lançamento. Isso cobre o caso em que a criação teve êxito
   * mas a resposta se perdeu (timeout) e a mensagem foi reprocessada pela fila.
   */
  async createTransactionFromAi(dto: CreateAiTransactionDto) {
    await this.assertCanUseProduct(dto.userId);

    if (dto.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(dto.idempotencyKey, dto.userId);
      if (existing) return this.comSaldoGarantido(existing);
    }

    const account = await this.prisma.account.findUnique({ where: { id: dto.accountId } });
    if (!account || account.userId !== dto.userId) {
      throw new BadRequestException('Conta inválida para o usuário');
    }
    assertAccountAcceptsEntries(account);
    assertAccountAcceptsType(account, dto.type);
    assertInstallmentIsExpense(dto.type, dto.recurrenceType);

    if (dto.categoryId) {
      const category = await this.prisma.category.findUnique({ where: { id: dto.categoryId } });
      if (!category || (category.userId !== null && category.userId !== dto.userId)) {
        throw new BadRequestException('Categoria inválida para o usuário');
      }
      // O LLM escolhe a categoria pelo nome: sem esta checagem, uma categoria
      // de receita (ou do outro perfil) entrava numa despesa.
      if (category.type !== dto.type) {
        throw new BadRequestException('Categoria incompatível com o tipo do lançamento');
      }
      const user = await this.prisma.user.findUnique({
        where: { id: dto.userId },
        select: { profileType: true },
      });
      if (user && category.profileType !== user.profileType) {
        throw new BadRequestException('Categoria de outro perfil');
      }
    }

    let transaction: Awaited<ReturnType<typeof this.persistAiTransaction>>;
    try {
      transaction = await this.persistAiTransaction(dto, account);
    } catch (err) {
      // Corrida no unique de idempotencyKey: outro worker criou primeiro.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        dto.idempotencyKey
      ) {
        const existing = await this.findByIdempotencyKey(dto.idempotencyKey, dto.userId);
        if (existing) return this.comSaldoGarantido(existing);
      }
      throw err;
    }

    return this.comSaldoGarantido(transaction);
  }

  /**
   * Recalcula o saldo da conta e a fatura do lançamento.
   *
   * Lançamento, liquidação à vista, saldo e fatura já são gravados no mesmo
   * commit (`persistAiTransaction`). Repetir aqui — inclusive no lançamento
   * devolvido pela idempotência — é uma garantia barata para registros
   * gravados antes disso: `recalculateBalance` recompõe o saldo do zero, e a
   * sincronização da fatura é idempotente.
   */
  private async comSaldoGarantido<
    T extends { id: string; status: string; accountId: string; seriesId?: string | null },
  >(transaction: T): Promise<T> {
    if (transaction.status === 'confirmed') {
      await this.accountsService.recalculateBalance(transaction.accountId);
    }
    // Mesma lógica do saldo vale para a fatura do cartão: sincronizar de novo
    // na reentrega é seguro e cobre o processo que morreu antes de sincronizar.
    // Numa série (parcelas), cada ocorrência vai para a sua fatura.
    const ids = transaction.seriesId
      ? (
          await this.prisma.transaction.findMany({
            where: { seriesId: transaction.seriesId },
            select: { id: true },
          })
        ).map((t) => t.id)
      : [transaction.id];
    await this.cardLedger.syncTransactions(ids);
    return transaction;
  }

  /**
   * Grava o lançamento — ou a série inteira, no fixo e no parcelado, com a
   * compra parcelada —, a liquidação à vista, a rastreabilidade da extração,
   * o saldo e a fatura na **mesma** transação de banco: ou tudo existe, ou
   * nada. Usa o mesmo gravador do formulário (`writeEntrySeries`).
   *
   * A chave de idempotência e a extração ficam só na 1ª ocorrência (a chave é
   * única no banco): a reentrega encontra a 1ª e devolve a série já criada.
   */
  private persistAiTransaction(dto: CreateAiTransactionDto, account: { id: string; type: string }) {
    const firstDate = parseDateOnly(dto.transactionDate);
    return this.prisma.$transaction(async (tx) => {
      await lockAccounts(tx, [account.id]);
      const { rows } = await writeEntrySeries(tx, {
        userId: dto.userId,
        account,
        categoryId: dto.categoryId ?? null,
        type: dto.type,
        description: dto.description,
        status: dto.status ?? 'confirmed',
        source: dto.source ?? 'ai',
        rawInput: dto.rawInput,
        recurrenceType: dto.recurrenceType,
        recurrenceFrequency: dto.recurrenceFrequency,
        installments: dto.installments,
        recurrenceMonths: dto.recurrenceMonths,
        amount: dto.amount,
        firstDate,
        // O modelo pode dizer "pago" para algo com data futura: nada foi pago
        // ainda, então fica em aberto em vez de recusar a mensagem.
        settle: dto.settle === undefined ? undefined : dto.settle && !isFutureDay(firstDate),
        settlementOrigin: dto.source === 'whatsapp' ? 'whatsapp' : 'at_sight',
        idempotencyKey: dto.idempotencyKey,
      });
      const transaction = rows[0];
      await this.accountsService.recalculateBalance(account.id, tx);
      await this.cardLedger.syncTransactions(
        rows.map((t) => t.id),
        tx,
      );

      if (dto.aiExtractedTransactionId) {
        await tx.aiExtractedTransaction.update({
          where: { id: dto.aiExtractedTransactionId },
          data: { transactionId: transaction.id, status: 'confirmed' },
        });
      }

      return transaction;
    }, FINANCIAL_TX_OPTIONS);
  }

  /** Lançamento já criado para uma chave de idempotência, marcado como tal. */
  private async findByIdempotencyKey(idempotencyKey: string, userId: string) {
    const existing = await this.prisma.transaction.findUnique({
      where: { idempotencyKey },
      include: { category: true, account: true },
    });
    if (!existing) return null;

    this.assertIdempotencyOwner(existing.userId, userId, 'lançamento');
    return { ...existing, idempotent: true };
  }

  /**
   * Recusa reaproveitar o registro de outro usuário para a mesma chave.
   *
   * A chave (`jobId`) é derivada do telefone e dos ids das mensagens, então duas
   * contas colidirem nela só acontece por bug a montante — e, sem esta checagem,
   * o segundo usuário recebia de volta o lançamento completo do primeiro.
   *
   * A busca continua pela coluna única e compara o dono em seguida, em vez de
   * filtrar por `userId` na consulta: filtrando, a colisão viraria "não achei",
   * seguiria para a criação e estouraria no unique como erro genérico. Assim ela
   * vira um 409 explícito, que não devolve nada do outro usuário.
   *
   * A unicidade continua **global**, e não por usuário, de propósito: uma
   * constraint composta aceitaria a colisão em silêncio, escondendo o bug que ela
   * denuncia.
   */
  private assertIdempotencyOwner(ownerId: string, userId: string, recurso: string): void {
    if (ownerId === userId) return;

    this.logger.error(
      `Chave de idempotência de ${recurso} já pertence a outro usuário; recusando reaproveitar`,
    );
    throw new ConflictException({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      message: 'Chave de idempotência já usada por outro usuário.',
    });
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

    const contact = await this.ensureContact(normalizePhone(dto.phone));
    const conversation = await this.resolveActiveConversation(contact);

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

  /**
   * Contato do telefone, criando se ainda não existe.
   *
   * `upsert` não é atômico contra inserts concorrentes: duas primeiras
   * mensagens do mesmo número chegando juntas faziam as duas tentarem o INSERT,
   * e uma estourava `P2002` — que virava `500`. Com o processamento por filas
   * isso passou a ser a norma, não a exceção.
   */
  private async ensureContact(phoneNumber: string) {
    try {
      return await this.prisma.whatsappContact.upsert({
        where: { phoneNumber },
        update: {},
        create: { phoneNumber },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.whatsappContact.findUnique({
          where: { phoneNumber },
        });
        if (existing) return existing;
      }
      throw err;
    }
  }

  /**
   * Conversa ativa do contato, criando se ainda não existe.
   *
   * O `findFirst` seguido de `create` deixava duas mensagens concorrentes
   * criarem **duas** conversas ativas para o mesmo contato. Não dava erro
   * nenhum, e o estrago era silencioso: `listRecentMessagesByPhone` devolve só
   * a conversa ativa mais recente, então o histórico que alimenta a IA ficava
   * partido entre elas.
   *
   * Serializamos travando a linha do contato — quem chega junto espera, lê a
   * conversa que o primeiro criou e a reaproveita. Contatos diferentes não se
   * bloqueiam.
   *
   * Um índice único parcial (`WHERE status = 'active'`) diria isso de forma
   * declarativa, mas o Prisma não expressa índice parcial no schema, e um
   * índice criado só em SQL aparece como drift na próxima `prisma migrate dev`
   * — que geraria uma migration para removê-lo.
   */
  private resolveActiveConversation(contact: {
    id: string;
    userId: string | null;
    isVerified: boolean;
    revokedAt: Date | null;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM whatsapp_contacts WHERE id = ${contact.id} FOR UPDATE`;

      const existing = await tx.aiConversation.findFirst({
        where: { whatsappContactId: contact.id, status: 'active' },
        orderBy: { createdAt: 'desc' },
      });

      if (existing) {
        await tx.aiConversation.update({
          where: { id: existing.id },
          data: { lastMessageAt: new Date() },
        });
        return existing;
      }

      return tx.aiConversation.create({
        data: {
          whatsappContactId: contact.id,
          // Número revogado mantém o userId antigo só para auditoria: a conversa
          // de quem tem o número agora não pode ser atribuída ao dono anterior.
          userId: isLinked(contact) ? contact.userId : null,
          status: 'active',
          lastMessageAt: new Date(),
        },
      });
    });
  }

  private async recordExtraction(dto: AiEventDto) {
    if (
      !dto.userId ||
      !dto.rawInput ||
      dto.extractedPayload === undefined ||
      dto.confidence === undefined
    ) {
      throw new BadRequestException(
        'userId, rawInput, extractedPayload e confidence são obrigatórios para extrações',
      );
    }

    // Idempotência: o reprocessamento de um job repete esta chamada. Sem isso,
    // a segunda extração ficaria órfã — a criação do lançamento é deduplicada
    // antes e não chega a vinculá-la.
    if (dto.idempotencyKey) {
      const existing = await this.findExtractionByIdempotencyKey(dto.idempotencyKey, dto.userId);
      if (existing) return existing;
    }

    try {
      const extraction = await this.prisma.aiExtractedTransaction.create({
        data: {
          userId: dto.userId,
          rawInput: dto.rawInput,
          extractedPayload: dto.extractedPayload as Prisma.InputJsonValue,
          confidence: dto.confidence,
          status: dto.status ?? 'pending',
          transactionId: dto.transactionId,
          sourceMessageId: dto.sourceMessageId,
          idempotencyKey: dto.idempotencyKey,
        },
      });
      return { id: extraction.id };
    } catch (err) {
      // Corrida no unique: outro worker gravou a mesma extração primeiro.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        dto.idempotencyKey
      ) {
        const existing = await this.findExtractionByIdempotencyKey(dto.idempotencyKey, dto.userId);
        if (existing) return existing;
      }
      throw err;
    }
  }

  /**
   * Extração já gravada para a chave. Mesma regra do lançamento: a de outro
   * usuário é recusada, nunca devolvida — senão o chamador vincularia depois o id
   * de uma extração que não é dele.
   */
  private async findExtractionByIdempotencyKey(idempotencyKey: string, userId: string) {
    const existing = await this.prisma.aiExtractedTransaction.findUnique({
      where: { idempotencyKey },
      select: { id: true, userId: true },
    });
    if (!existing) return null;

    this.assertIdempotencyOwner(existing.userId, userId, 'extração');
    return { id: existing.id, duplicate: true as const };
  }
}
