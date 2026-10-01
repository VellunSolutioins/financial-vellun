import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CardPayment, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { isFutureDay, parseDateOnly } from '../common/date.util';
import { CreateCardPaymentDto } from './dto/create-card-payment.dto';

type PaymentWithSource = CardPayment & { sourceAccount: { id: string; name: string } };

function paymentView(payment: PaymentWithSource, idempotent = false) {
  return {
    id: payment.id,
    creditCardId: payment.creditCardId,
    invoiceId: payment.invoiceId,
    sourceAccountId: payment.sourceAccountId,
    sourceAccount: payment.sourceAccount,
    amount: Number(payment.amount),
    paymentDate: payment.paymentDate.toISOString().slice(0, 10),
    status: payment.status,
    reversedAt: payment.reversedAt,
    ...(idempotent && { idempotent: true }),
  };
}

const includeSource = { sourceAccount: { select: { id: true, name: true } } } as const;

/**
 * Pagamento de fatura: uma saída da conta comum e uma entrada no cartão, as
 * duas `transfer` — nunca receita nem despesa, então não mexe em categorias.
 * Parcial, múltiplo e de contas diferentes são permitidos; acima do restante,
 * o excedente vira crédito no cartão.
 */
@Injectable()
export class CardPaymentsService {
  private readonly logger = new Logger(CardPaymentsService.name);

  constructor(
    private prisma: PrismaService,
    private accountsService: AccountsService,
  ) {}

  async listForInvoice(invoiceId: string) {
    const payments = await this.prisma.cardPayment.findMany({
      where: { invoiceId },
      include: includeSource,
      orderBy: [{ paymentDate: 'asc' }, { createdAt: 'asc' }],
    });
    return payments.map((p) => paymentView(p));
  }

  /**
   * Idempotente pela `idempotencyKey`: a mesma chave devolve o mesmo pagamento
   * (duplo clique, retry depois de timeout). Corrida entre duas requisições com
   * a mesma chave cai no unique e também devolve o existente, como em
   * `InternalService.createTransactionFromAi`.
   */
  async pay(userId: string, cardId: string, invoiceId: string, dto: CreateCardPaymentDto) {
    const existing = await this.findByKey(dto.idempotencyKey, userId);
    if (existing) return existing;

    const card = await this.prisma.creditCard.findUnique({
      where: { id: cardId },
      include: { account: true },
    });
    if (!card || card.account.userId !== userId) {
      throw new NotFoundException('Cartão não encontrado');
    }
    const invoice = await this.prisma.creditCardInvoice.findFirst({
      where: { id: invoiceId, creditCardId: card.id },
    });
    if (!invoice) throw new NotFoundException('Fatura não encontrada');

    const source = await this.prisma.account.findUnique({ where: { id: dto.sourceAccountId } });
    if (!source || source.userId !== userId || !source.isActive || source.type === 'credit_card') {
      throw new BadRequestException('Conta de origem inválida: use uma conta comum ativa');
    }

    const paymentDate = parseDateOnly(dto.paymentDate.slice(0, 10));
    if (isFutureDay(paymentDate)) {
      throw new BadRequestException('A data do pagamento não pode ser futura');
    }

    const description = `Pagamento da fatura ${card.account.name} ${invoice.referenceMonth.slice(5)}/${invoice.referenceMonth.slice(0, 4)}`;
    let payment: PaymentWithSource;
    try {
      payment = await this.prisma.$transaction(async (tx) => {
        const created = await tx.cardPayment.create({
          data: {
            userId,
            creditCardId: card.id,
            invoiceId: invoice.id,
            sourceAccountId: source.id,
            amount: dto.amount,
            paymentDate,
            idempotencyKey: dto.idempotencyKey,
          },
          include: includeSource,
        });
        const leg = {
          userId,
          type: 'transfer' as const,
          amount: dto.amount,
          description,
          transactionDate: paymentDate,
          status: 'confirmed' as const,
          source: 'manual' as const,
          cardPaymentId: created.id,
        };
        await tx.transaction.createMany({
          data: [
            { ...leg, accountId: source.id, transferDirection: 'out' },
            { ...leg, accountId: card.accountId, transferDirection: 'in' },
          ],
        });
        return created;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await this.findByKey(dto.idempotencyKey, userId);
        if (raced) return raced;
      }
      throw err;
    }

    await this.accountsService.recalculateBalance(source.id);
    await this.accountsService.recalculateBalance(card.accountId);
    return paymentView(payment);
  }

  /** Reverter preserva o histórico: o pagamento fica `reversed` e as pernas, canceladas. */
  async reverse(userId: string, cardId: string, invoiceId: string, paymentId: string) {
    const payment = await this.prisma.cardPayment.findFirst({
      where: { id: paymentId, invoiceId, creditCardId: cardId, userId },
      include: { ...includeSource, creditCard: { select: { accountId: true } } },
    });
    if (!payment) throw new NotFoundException('Pagamento não encontrado');
    if (payment.status === 'reversed') return paymentView(payment);

    const [reversed] = await this.prisma.$transaction([
      this.prisma.cardPayment.update({
        where: { id: payment.id },
        data: { status: 'reversed', reversedAt: new Date() },
        include: includeSource,
      }),
      this.prisma.transaction.updateMany({
        where: { cardPaymentId: payment.id },
        data: { status: 'cancelled' },
      }),
    ]);
    await this.accountsService.recalculateBalance(payment.sourceAccountId);
    await this.accountsService.recalculateBalance(payment.creditCard.accountId);
    return paymentView(reversed);
  }

  private async findByKey(idempotencyKey: string, userId: string) {
    const existing = await this.prisma.cardPayment.findUnique({
      where: { idempotencyKey },
      include: includeSource,
    });
    if (!existing) return null;
    if (existing.userId !== userId) {
      // Chave gerada pela tela de outro usuário só colide por bug: não devolve
      // nada dele (mesmo raciocínio de InternalService.assertIdempotencyOwner).
      this.logger.error('Chave de idempotência de pagamento reaproveitada por outro usuário');
      throw new ConflictException('Chave de idempotência já utilizada');
    }
    return paymentView(existing, true);
  }
}
