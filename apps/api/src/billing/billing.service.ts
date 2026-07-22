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

    const webUrl = this.webUrl();
    const successUrl = `${webUrl}/app/conta/assinatura?status=success`;

    // Planos gratuitos (ex.: "Local Dev Active", uso interno/testes) pulam o
    // PSP: o Asaas recusa cobranças abaixo de R$ 5,00, então uma cobrança de
    // R$ 0,00 seria sempre rejeitada no checkout.
    if (Number(plan.price.toString()) === 0) {
      await this.subscriptions.activateFreeSubscription(userId, plan.id, plan.interval, 'checkout');
      return { checkoutUrl: successUrl };
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { individualProfile: true, businessProfile: true },
    });
    const document = user.individualProfile?.cpf ?? user.businessProfile?.cnpj ?? null;

    let providerCustomerId = current?.providerCustomerId ?? null;
    if (!providerCustomerId) {
      // O provedor de pagamentos exige telefone + endereço completo para
      // checkout com cartão. Validamos aqui para devolver um erro acionável em
      // vez de deixar o provedor recusar com uma mensagem genérica.
      this.assertBillingProfileComplete(user);
      const customer = await this.provider.createCustomer({
        userId,
        name: user.name,
        email: user.email,
        phone: user.phone,
        document,
        postalCode: user.postalCode,
        street: user.street,
        addressNumber: user.addressNumber,
        complement: user.complement,
        neighborhood: user.neighborhood,
      });
      providerCustomerId = customer.id;
    }

    const checkout = await this.provider.createCheckout({
      userId,
      planCode: plan.code,
      providerCustomerId,
      interval: plan.interval,
      amount: plan.price.toString(),
      currency: plan.currency,
      successUrl,
      cancelUrl: `${webUrl}/app/conta/assinatura?status=cancel`,
    });

    await this.subscriptions.prepareCheckoutSubscription(userId, plan.id, providerCustomerId);

    return { checkoutUrl: checkout.checkoutUrl };
  }

  /**
   * Garante que o usuário tem telefone + endereço de cobrança completos antes de
   * abrir o checkout. Sem isso, o provedor recusa a criação do cliente.
   */
  private assertBillingProfileComplete(user: {
    phone: string | null;
    postalCode: string | null;
    street: string | null;
    addressNumber: string | null;
    neighborhood: string | null;
  }) {
    const missing: string[] = [];
    if (!user.phone) missing.push('telefone');
    if (!user.postalCode) missing.push('CEP');
    if (!user.street) missing.push('logradouro');
    if (!user.addressNumber) missing.push('número');
    if (!user.neighborhood) missing.push('bairro');

    if (missing.length > 0) {
      throw new BadRequestException(
        `Complete seu endereço de cobrança em "Minha Conta" antes de assinar (faltando: ${missing.join(', ')}).`,
      );
    }
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

  /**
   * Base das URLs de redirecionamento enviadas ao provedor de pagamentos
   * (successUrl/cancelUrl/returnUrl). O Asaas **recusa `localhost`**, então em
   * desenvolvimento use `BILLING_CALLBACK_BASE_URL` apontando para uma URL
   * pública (ex.: túnel ngrok). Em produção cai no `WEB_URL` do domínio real.
   */
  private webUrl(): string {
    return (
      this.config.get<string>('BILLING_CALLBACK_BASE_URL') ??
      this.config.get<string>('WEB_URL') ??
      'http://localhost:3000'
    );
  }
}
