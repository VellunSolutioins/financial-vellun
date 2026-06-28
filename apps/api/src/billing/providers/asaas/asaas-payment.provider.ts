import { timingSafeEqual } from 'node:crypto';

import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotImplementedException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  CancelSubscriptionInput,
  CheckoutSession,
  CreateCheckoutInput,
  CreateCustomerInput,
  PaymentMethodUpdateInput,
  PaymentMethodUpdateSession,
  PaymentProvider,
  ProviderCustomer,
  ProviderPayment,
  ProviderRefund,
  ProviderSubscription,
  RefundPaymentInput,
  VerifiedPaymentEvent,
  VerifyWebhookInput,
} from '../payment-provider.interface';
import { AsaasHttpClient } from './asaas.http-client';
import { mapPayment, mapSubscription, toAsaasCycle } from './asaas.mapper';
import {
  AsaasCheckout,
  AsaasCustomer,
  AsaasList,
  AsaasPayment,
  AsaasRefund,
  AsaasSubscription,
  AsaasWebhookEvent,
} from './asaas.types';

/**
 * Único módulo autorizado a falar com o Asaas. Mapeia tudo para os tipos
 * internos de `PaymentProvider`; nenhum tipo do Asaas vaza para fora daqui.
 *
 * A configuração é lida de forma preguiçosa para que a API suba mesmo sem as
 * credenciais do Asaas (pendentes do Prompt 0); os métodos só falham quando
 * efetivamente chamados sem configuração.
 */
@Injectable()
export class AsaasPaymentProvider implements PaymentProvider {
  private readonly logger = new Logger(AsaasPaymentProvider.name);
  private client?: AsaasHttpClient;

  constructor(private readonly config: ConfigService) {}

  async createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer> {
    const customer = await this.getClient().post<AsaasCustomer>('/customers', {
      name: input.name,
      email: input.email,
      cpfCnpj: input.document ?? undefined,
      mobilePhone: input.phone ?? undefined,
      externalReference: input.userId,
    });
    return { id: customer.id };
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const checkout = await this.getClient().post<AsaasCheckout>('/checkouts', {
      billingTypes: ['CREDIT_CARD'],
      chargeTypes: ['RECURRENT'],
      minutesToExpire: 60,
      customer: input.providerCustomerId,
      callback: {
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
      },
      items: [
        {
          name: input.planCode,
          quantity: 1,
          value: Number(input.amount),
        },
      ],
      subscription: {
        cycle: toAsaasCycle(input.interval),
      },
    });

    const checkoutUrl = checkout.link ?? checkout.url;
    if (!checkoutUrl) {
      throw new InternalServerErrorException('Asaas não retornou URL de checkout');
    }
    return { checkoutUrl, providerCheckoutId: checkout.id };
  }

  async createPaymentMethodUpdateSession(
    _input: PaymentMethodUpdateInput,
  ): Promise<PaymentMethodUpdateSession> {
    // O fluxo seguro de atualização de cartão depende de confirmação do Asaas
    // (doc 12.3 / Prompt 0). Será implementado quando o mecanismo for definido,
    // sem nunca solicitar dados completos do cartão ao backend.
    throw new NotImplementedException(
      'Atualização de cartão pendente de definição do fluxo Asaas (Prompt 0)',
    );
  }

  async cancelSubscription(input: CancelSubscriptionInput): Promise<void> {
    // DELETE interrompe a geração de novas cobranças no Asaas. A regra de
    // acesso até o fim do período já pago é tratada na camada de domínio.
    await this.getClient().delete<unknown>(`/subscriptions/${input.providerSubscriptionId}`);
  }

  async getSubscription(providerSubscriptionId: string): Promise<ProviderSubscription> {
    const sub = await this.getClient().get<AsaasSubscription>(
      `/subscriptions/${providerSubscriptionId}`,
    );
    return mapSubscription(sub);
  }

  async listSubscriptionPayments(providerSubscriptionId: string): Promise<ProviderPayment[]> {
    const list = await this.getClient().get<AsaasList<AsaasPayment>>(
      `/subscriptions/${providerSubscriptionId}/payments`,
    );
    return (list.data ?? []).map(mapPayment);
  }

  async refundPayment(input: RefundPaymentInput): Promise<ProviderRefund> {
    const refund = await this.getClient().post<AsaasRefund>(
      `/payments/${input.providerPaymentId}/refund`,
      input.amount ? { value: Number(input.amount) } : {},
    );
    return { id: refund.id ?? input.providerPaymentId, status: refund.status ?? 'requested' };
  }

  async verifyWebhook(input: VerifyWebhookInput): Promise<VerifiedPaymentEvent> {
    const expected = this.config.get<string>('ASAAS_WEBHOOK_TOKEN');
    if (!expected) {
      throw new InternalServerErrorException('ASAAS_WEBHOOK_TOKEN não configurado');
    }

    const provided =
      input.signature ?? (this.headerValue(input.headers, 'asaas-access-token') as string);
    if (!provided || !this.safeEqual(provided, expected)) {
      throw new UnauthorizedException('Assinatura de webhook do Asaas inválida');
    }

    const event = this.parseEvent(input.rawBody);
    if (!event.id || !event.event) {
      throw new UnauthorizedException('Payload de webhook do Asaas inválido');
    }

    return {
      providerEventId: event.id,
      eventType: event.event,
      payload: event,
    };
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  private getClient(): AsaasHttpClient {
    if (this.client) return this.client;

    const baseUrl = this.config.get<string>('ASAAS_API_URL');
    const apiKey = this.config.get<string>('ASAAS_API_KEY');
    if (!baseUrl || !apiKey) {
      throw new InternalServerErrorException('Credenciais do Asaas não configuradas (Prompt 0)');
    }

    this.client = new AsaasHttpClient({ baseUrl, apiKey });
    return this.client;
  }

  private parseEvent(rawBody: Buffer | string): AsaasWebhookEvent {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    try {
      return JSON.parse(text) as AsaasWebhookEvent;
    } catch {
      throw new UnauthorizedException('Corpo do webhook do Asaas não é JSON válido');
    }
  }

  private headerValue(
    headers: VerifyWebhookInput['headers'],
    name: string,
  ): string | undefined {
    const value = headers?.[name];
    return Array.isArray(value) ? value[0] : value;
  }

  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
