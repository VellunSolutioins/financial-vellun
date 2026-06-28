import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { PAYMENT_PROVIDER, PaymentProvider } from './providers/payment-provider.interface';
import { SubscriptionAccessService } from './services/subscription-access.service';
import { SubscriptionService } from './services/subscription.service';

@Injectable()
export class BillingService {
  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionService,
    private readonly access: SubscriptionAccessService,
    private readonly config: ConfigService,
  ) {}

  listPlans() {
    return this.subscriptions.getActivePlans();
  }

  /** Estado comercial atual do usuário, incluindo a regra de acesso. */
  async getSubscriptionState(userId: string) {
    const subscription = await this.subscriptions.getUserSubscription(userId);
    const access = this.access.evaluate(subscription);

    return {
      status: subscription?.status ?? null,
      plan: subscription?.plan ?? null,
      currentPeriodStart: subscription?.currentPeriodStart ?? null,
      currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
      trialEndsAt: subscription?.trialEndsAt ?? null,
      graceUntil: subscription?.graceUntil ?? null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      canceledAt: subscription?.canceledAt ?? null,
      access,
    };
  }

  /**
   * Cria/recupera o cliente no Asaas e abre um checkout recorrente. **Não ativa**
   * a assinatura — apenas registra uma assinatura `pending` correlacionável.
   */
  async createCheckout(userId: string, dto: CreateCheckoutDto) {
    const plan = await this.prisma.plan.findUnique({ where: { id: dto.planId } });
    if (!plan || !plan.isActive) {
      throw new NotFoundException('Plano não encontrado');
    }

    const current = await this.subscriptions.getUserSubscription(userId);
    if (current && this.access.evaluate(current).allowed) {
      throw new BadRequestException('Você já possui uma assinatura ativa.');
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { individualProfile: true, businessProfile: true },
    });
    const document = user.individualProfile?.cpf ?? user.businessProfile?.cnpj ?? null;

    let providerCustomerId = current?.providerCustomerId ?? null;
    if (!providerCustomerId) {
      const customer = await this.provider.createCustomer({
        userId,
        name: user.name,
        email: user.email,
        phone: user.phone,
        document,
      });
      providerCustomerId = customer.id;
    }

    const webUrl = this.webUrl();
    const checkout = await this.provider.createCheckout({
      userId,
      planCode: plan.code,
      providerCustomerId,
      interval: plan.interval,
      amount: plan.price.toString(),
      currency: plan.currency,
      successUrl: `${webUrl}/app/conta/assinatura?status=success`,
      cancelUrl: `${webUrl}/app/conta/assinatura?status=cancel`,
    });

    await this.subscriptions.prepareCheckoutSubscription(userId, plan.id, providerCustomerId);

    return { checkoutUrl: checkout.checkoutUrl };
  }

  /** Abre o fluxo seguro de atualização de cartão (hospedado pelo Asaas). */
  async createPaymentMethodSession(userId: string) {
    const current = await this.subscriptions.getUserSubscription(userId);
    if (!current?.providerSubscriptionId || !current.providerCustomerId) {
      throw new BadRequestException('Nenhuma assinatura disponível para atualizar o cartão.');
    }

    return this.provider.createPaymentMethodUpdateSession({
      providerCustomerId: current.providerCustomerId,
      providerSubscriptionId: current.providerSubscriptionId,
      returnUrl: `${this.webUrl()}/app/conta/assinatura`,
    });
  }

  /**
   * Cancela ao fim do período pago: interrompe novas cobranças no Asaas e marca
   * `cancelAtPeriodEnd = true`, mantendo o acesso até `currentPeriodEnd`.
   */
  async cancel(userId: string) {
    const current = await this.subscriptions.getUserSubscription(userId);
    if (!current) {
      throw new NotFoundException('Assinatura não encontrada');
    }

    if (current.providerSubscriptionId) {
      await this.provider.cancelSubscription({
        providerSubscriptionId: current.providerSubscriptionId,
        cancelAtPeriodEnd: true,
      });
    }

    await this.subscriptions.scheduleCancellation(current.id, 'user');
    return this.getSubscriptionState(userId);
  }

  private webUrl(): string {
    return this.config.get<string>('WEB_URL') ?? 'http://localhost:3000';
  }
}
