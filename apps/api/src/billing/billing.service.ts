import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SubscriptionStatus } from '@prisma/client';

import { webUrl } from '../common/web-url.util';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import {
  CustomerProfileField,
  PAYMENT_PROVIDER,
  PaymentProvider,
} from './providers/payment-provider.interface';
import { SubscriptionAccessService } from './services/subscription-access.service';
import { SubscriptionService } from './services/subscription.service';

/** Nome de cada dado do cadastro, como aparece na mensagem ao usuário. */
const PROFILE_FIELD_LABELS: Record<CustomerProfileField, string> = {
  // Os mesmos nomes do aviso na tela de assinatura.
  phone: 'celular',
  document: 'CPF/CNPJ',
  postalCode: 'CEP',
  street: 'logradouro',
  addressNumber: 'número',
  neighborhood: 'bairro',
};

/** Estados de uma assinatura em vigor — os únicos que se cancelam. */
const CANCELABLE_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.active,
  SubscriptionStatus.trialing,
  SubscriptionStatus.past_due,
];

type CurrentSubscription = Awaited<ReturnType<SubscriptionAccessService['currentSubscription']>>;

/** O que do cadastro vai para o PSP ao criar o cliente. */
interface BillingProfile {
  phone: string | null;
  postalCode: string | null;
  street: string | null;
  addressNumber: string | null;
  neighborhood: string | null;
  individualProfile?: { cpf: string | null } | null;
  businessProfile?: { cnpj: string | null } | null;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

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
    const subscription = await this.access.currentSubscription(userId);
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
      lastPaymentFailure: subscription?.lastPaymentFailureAt
        ? {
            at: subscription.lastPaymentFailureAt,
            reason: subscription.lastPaymentFailureReason,
          }
        : null,
      // A tela bloqueia a assinatura enquanto houver pendência; a regra é a
      // mesma que o checkout aplica.
      missingBillingFields: await this.missingBillingFieldsOf(userId, subscription),
      access,
    };
  }

  /**
   * Abre um checkout recorrente no PSP. **Não ativa** a assinatura: registra
   * uma assinatura `pending`, que só vira `active` quando o pagamento chega.
   *
   * A ordem das escritas é a que sobrevive a uma falha no meio: primeiro a
   * assinatura local, depois o cliente no PSP (gravado na hora), por fim o
   * checkout. Com o banco por último, o que tivesse sido criado no PSP ficava
   * sem dono aqui.
   */
  async createCheckout(userId: string, dto: CreateCheckoutDto) {
    const plan = await this.prisma.plan.findUnique({ where: { id: dto.planId } });
    if (!plan || !plan.isActive) {
      throw new NotFoundException('Plano não encontrado');
    }

    const current = await this.access.currentSubscription(userId);
    if (current && this.isInGoodStanding(current)) {
      throw new BadRequestException('Você já possui uma assinatura ativa.');
    }

    // Um checkout anterior já virou assinatura no PSP e o pagamento dele ainda
    // está em análise, sem recusa. Abrir outro agora cobraria duas vezes — e, aprovado o
    // segundo, a primeira assinatura seria cancelada sem estorno do que cobrou.
    const awaitingPayment = await this.prisma.subscription.findFirst({
      where: {
        userId,
        // A de outro PSP não tem mais quem a resolva aqui: nem webhook nem
        // reconciliação a enxergam. Bloquear por ela seria para sempre.
        provider: this.provider.name,
        status: SubscriptionStatus.pending,
        providerSubscriptionId: { not: null },
        // Recusado o pagamento, não há mais o que esperar dele.
        lastPaymentFailureAt: null,
      },
      select: { id: true },
    });
    if (awaitingPayment) {
      throw new BadRequestException(
        'O pagamento da sua assinatura anterior ainda está em análise. ' +
          'Aguarde a confirmação antes de tentar de novo.',
      );
    }

    const webUrl = this.webUrl();
    const successUrl = `${webUrl}/app/conta/assinatura?status=success`;

    // Planos gratuitos (ex.: "Local Dev Active", uso interno/testes) pulam o
    // PSP: o Asaas recusa cobranças abaixo de R$ 5,00, então uma cobrança de
    // R$ 0,00 seria sempre rejeitada no checkout.
    if (Number(plan.price.toString()) === 0) {
      // Em produção o atalho não existe. O seed já desativa o plano gratuito
      // lá, mas uma linha ativada à mão daria acesso sem cobrança a qualquer um.
      if (this.config.get<string>('NODE_ENV') === 'production') {
        throw new NotFoundException('Plano não encontrado');
      }
      await this.subscriptions.activateFreeSubscription(userId, plan.id, plan.interval, 'checkout');
      return { checkoutUrl: successUrl };
    }

    const user = await this.findBillingProfile(userId);

    let providerCustomerId = this.reusableCustomerId(current);
    // O PSP pode exigir dados do cadastro (o Asaas exige CPF). Validamos aqui,
    // antes de criar qualquer coisa, para devolver um erro acionável em vez de
    // deixar o PSP recusar com uma mensagem genérica. A tela já bloqueia antes;
    // isto é a última barreira.
    const missing = this.missingBillingFields(user, current);
    if (missing.length > 0) {
      throw new BadRequestException(
        `Complete seus dados de cobrança em "Minha Conta" antes de assinar ` +
          `(faltando: ${missing.map((field) => PROFILE_FIELD_LABELS[field]).join(', ')}).`,
      );
    }

    const subscription = await this.subscriptions.prepareCheckoutSubscription(
      userId,
      plan.id,
      this.provider.name,
      providerCustomerId,
    );

    try {
      if (!providerCustomerId) {
        const customer = await this.provider.createCustomer({
          userId,
          name: user.name,
          email: user.email,
          phone: user.phone,
          document: user.individualProfile?.cpf ?? user.businessProfile?.cnpj ?? null,
          postalCode: user.postalCode,
          street: user.street,
          addressNumber: user.addressNumber,
          complement: user.complement,
          neighborhood: user.neighborhood,
        });
        providerCustomerId = customer.id;
        await this.subscriptions.attachCustomer(subscription.id, providerCustomerId);
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
        externalReference: subscription.id,
      });

      if (checkout.providerCheckoutId) {
        await this.subscriptions.attachCheckout(subscription.id, {
          providerCheckoutId: checkout.providerCheckoutId,
          expiresAt: checkout.expiresAt ?? null,
        });
      }

      return { checkoutUrl: checkout.checkoutUrl };
    } catch (error) {
      // Sem checkout aberto, a assinatura `pending` deixaria a tela em
      // "pagamento em processamento" sem haver o que pagar.
      await this.subscriptions
        .expireCheckout(subscription.id, 'checkout', 'falha ao abrir o checkout no PSP')
        .catch((expireError: unknown) => {
          const message = expireError instanceof Error ? expireError.message : String(expireError);
          this.logger.warn(
            `Checkout da assinatura ${subscription.id} falhou e ela não pôde ser expirada ` +
              `(${message}); a reconciliação a expira depois.`,
          );
        });
      throw error;
    }
  }

  /**
   * Em dia: `active`, ou em teste ainda válido. Quem está inadimplente — mesmo
   * dentro do grace — pode abrir um checkout novo para regularizar.
   */
  private isInGoodStanding(subscription: Parameters<SubscriptionAccessService['evaluate']>[0]) {
    if (!subscription) return false;
    if (subscription.status === SubscriptionStatus.active) return true;
    return (
      subscription.status === SubscriptionStatus.trialing &&
      this.access.evaluate(subscription).allowed
    );
  }

  /**
   * {@link missingBillingFields} para o estado da assinatura, chamado a cada
   * carga do app. Com cliente já criado no PSP — o caso de quem assina —, nada
   * falta e o cadastro nem é lido.
   */
  private async missingBillingFieldsOf(
    userId: string,
    current: CurrentSubscription,
  ): Promise<CustomerProfileField[]> {
    if (this.reusableCustomerId(current)) return [];
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { individualProfile: true, businessProfile: true },
    });
    // Usuário que sumiu no meio da sessão: não há o que assinar, mas a tela
    // não deve quebrar por isso.
    if (!user) return [...this.provider.requiredCustomerFields];
    return this.missingBillingFields(user, current);
  }

  private findBillingProfile(userId: string) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { individualProfile: true, businessProfile: true },
    });
  }

  /** Cliente já criado no PSP configurado; o de outro PSP não vale aqui. */
  private reusableCustomerId(current: CurrentSubscription): string | null {
    return current?.provider === this.provider.name ? (current.providerCustomerId ?? null) : null;
  }

  /**
   * O que falta no cadastro para o PSP criar o cliente
   * (`requiredCustomerFields`). Com cliente já criado no PSP, nada falta: o
   * checkout o reusa sem mandar o cadastro de novo — é o caso de quem
   * regulariza um pagamento atrasado.
   */
  private missingBillingFields(
    user: BillingProfile,
    current: CurrentSubscription,
  ): CustomerProfileField[] {
    if (this.reusableCustomerId(current)) return [];
    const values: Record<CustomerProfileField, string | null | undefined> = {
      phone: user.phone,
      document: user.individualProfile?.cpf ?? user.businessProfile?.cnpj,
      postalCode: user.postalCode,
      street: user.street,
      addressNumber: user.addressNumber,
      neighborhood: user.neighborhood,
    };
    return this.provider.requiredCustomerFields.filter((field) => !values[field]);
  }

  /**
   * Cancela ao fim do período pago: interrompe novas cobranças no PSP e marca
   * `cancelAtPeriodEnd = true`, mantendo o acesso até `currentPeriodEnd`.
   *
   * A intenção é gravada **antes** de avisar o PSP, e não é desfeita se ele
   * falhar. O PSP exclui a assinatura na hora e manda o aviso de cancelamento;
   * com a flag falsa, o webhook cancelaria imediatamente e o usuário perderia o
   * resto do período que já pagou. E um erro do PSP não diz se o cancelamento
   * foi aplicado: a resposta pode ter se perdido depois de ele excluir.
   *
   * Sem a confirmação do PSP, a intenção gravada é o que garante o resultado:
   * a reconciliação refaz o cancelamento lá enquanto a assinatura continuar
   * ativa, e repetir o pedido também o refaz.
   */
  async cancel(userId: string) {
    const current = await this.access.currentSubscription(userId);
    if (!current) {
      throw new NotFoundException('Assinatura não encontrada');
    }
    // Só se cancela o que está em vigor. Uma flag gravada numa tentativa
    // `pending` sobreviveria ao pagamento, e a reconciliação, cumprindo o
    // pedido, cancelaria no PSP a assinatura que o usuário acabou de pagar.
    if (!CANCELABLE_STATUSES.includes(current.status)) {
      throw new BadRequestException('Não há assinatura em vigor para cancelar.');
    }

    if (!current.cancelAtPeriodEnd) {
      await this.subscriptions.scheduleCancellation(current.id, 'user');
    }

    if (current.providerSubscriptionId && current.provider !== this.provider.name) {
      // O id é de outro PSP: mandá-lo a este daria 404, tratado como "já
      // cancelada", e a cobrança lá continuaria. Nem a reconciliação o refaz,
      // porque só enxerga as deste PSP.
      this.logger.error(
        `Cancelamento da assinatura ${current.id} agendado, mas ela é do PSP ` +
          `${current.provider}, não do configurado (${this.provider.name}); ` +
          'cancele no painel daquele PSP.',
      );
    } else if (current.providerSubscriptionId) {
      try {
        await this.provider.cancelSubscription({
          providerSubscriptionId: current.providerSubscriptionId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Cancelamento da assinatura ${current.id} agendado, mas o PSP não confirmou ` +
            `(${message}); a reconciliação refaz.`,
        );
      }
    }

    return this.getSubscriptionState(userId);
  }

  /**
   * Base das URLs de redirecionamento enviadas ao provedor de pagamentos
   * (successUrl/cancelUrl/returnUrl). O Asaas **recusa `localhost`**, então em
   * desenvolvimento use `BILLING_CALLBACK_BASE_URL` apontando para uma URL
   * pública (ex.: túnel ngrok). Em produção cai no `WEB_URL` do domínio real.
   */
  private webUrl(): string {
    return this.config.get<string>('BILLING_CALLBACK_BASE_URL') ?? webUrl(this.config);
  }
}
