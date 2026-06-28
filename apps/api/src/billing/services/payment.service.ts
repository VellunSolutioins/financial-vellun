import { Injectable } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

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

@Injectable()
export class PaymentService {
  constructor(private readonly prisma: PrismaService) {}

  /** Cria ou atualiza um pagamento por `providerPaymentId` (idempotente). */
  upsertFromProvider(input: UpsertPaymentInput) {
    const data = {
      status: input.status,
      amount: input.amount,
      currency: input.currency,
      subscriptionId: input.subscriptionId,
      dueAt: input.dueAt ?? null,
      paidAt: input.paidAt ?? null,
      failedAt: input.failedAt ?? null,
    };

    return this.prisma.payment.upsert({
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
