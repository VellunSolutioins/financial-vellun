import { Injectable } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';

import { Db } from '../../common/db';
import { PrismaService } from '../../prisma/prisma.service';
import { DECISIVE_PAYMENT_STATUSES } from './subscription-state.service';

export interface UpsertPaymentInput {
  userId: string;
  subscriptionId: string | null;
  providerPaymentId: string;
  amount: string;
  currency: string;
  status: PaymentStatus;
  dueAt?: Date | null;
  paidAt?: Date | null;
  failedAt?: Date | null;
}

const PAYMENT_STATUSES = new Set<string>(Object.values(PaymentStatus));

/**
 * Status normalizado do PSP para o enum do banco. Os adapters já devolvem os
 * mesmos nomes; um valor desconhecido vira `processing`, que não decide nada.
 */
export function toPaymentStatus(status: string): PaymentStatus {
  return PAYMENT_STATUSES.has(status) ? (status as PaymentStatus) : PaymentStatus.processing;
}

@Injectable()
export class PaymentService {
  constructor(private readonly prisma: PrismaService) {}

  // Todos os métodos aceitam `db`: dentro da transação do evento, as leituras
  // precisam enxergar o que ela mesma gravou, e as escritas, entrar no commit dela.

  findByProviderId(providerPaymentId: string, db: Db = this.prisma) {
    return db.payment.findUnique({ where: { providerPaymentId } });
  }

  /**
   * Existe cobrança mais nova da mesma assinatura que já decidiu algo? Se sim,
   * a cobrança em mãos é passado: só a mais recente manda no estado da
   * assinatura. É o que impede um evento atrasado de desfazer o que veio depois.
   */
  async hasNewerDecisiveCharge(
    subscriptionId: string,
    providerPaymentId: string,
    dueAt: Date | null,
    db: Db = this.prisma,
  ): Promise<boolean> {
    if (!dueAt) return false;
    const newer = await db.payment.findFirst({
      where: {
        subscriptionId,
        providerPaymentId: { not: providerPaymentId },
        dueAt: { gt: dueAt },
        status: { in: DECISIVE_PAYMENT_STATUSES },
      },
      select: { id: true },
    });
    return newer !== null;
  }

  /**
   * Há outra cobrança da assinatura em disputa? Enquanto houver, pagamento
   * nenhum devolve o acesso: a contestação pode ser de um mês antigo, com os
   * seguintes pagos em dia.
   */
  async hasOpenChargeback(
    subscriptionId: string,
    exceptProviderPaymentId: string,
    db: Db = this.prisma,
  ) {
    const open = await db.payment.findFirst({
      where: {
        subscriptionId,
        providerPaymentId: { not: exceptProviderPaymentId },
        status: PaymentStatus.chargeback,
      },
      select: { id: true },
    });
    return open !== null;
  }

  /** Cobranças da assinatura registradas aqui como em disputa. */
  findChargebacks(subscriptionId: string, db: Db = this.prisma) {
    return db.payment.findMany({
      where: { subscriptionId, status: PaymentStatus.chargeback },
    });
  }

  /** Cria ou atualiza um pagamento por `providerPaymentId` (idempotente). */
  upsertFromProvider(input: UpsertPaymentInput, db: Db = this.prisma) {
    const data = {
      status: input.status,
      amount: input.amount,
      currency: input.currency,
      subscriptionId: input.subscriptionId,
      dueAt: input.dueAt ?? null,
      paidAt: input.paidAt ?? null,
      failedAt: input.failedAt ?? null,
    };

    return db.payment.upsert({
      where: { providerPaymentId: input.providerPaymentId },
      update: data,
      create: {
        userId: input.userId,
        providerPaymentId: input.providerPaymentId,
        ...data,
      },
    });
  }
}
