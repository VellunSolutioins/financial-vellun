import { timingSafeEqual } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  CancelSubscriptionInput,
  CheckoutSession,
  CreateCheckoutInput,
  CreateCustomerInput,
  CustomerProfileField,
  NormalizedWebhookEvent,
  PaymentProvider,
  ProviderCustomer,
  ProviderPayment,
  ProviderRefund,
  ProviderSubscription,
  RefundPaymentInput,
  VerifiedPaymentEvent,
  VerifyWebhookInput,
} from '../payment-provider.interface';
import { PaymentProviderError } from '../payment-provider.errors';
import { AsaasApiError, AsaasHttpClient } from './asaas.http-client';
import { mapPayment, mapSubscription, toAsaasCycle } from './asaas.mapper';
import { normalizeAsaasWebhookEvent } from './asaas-webhook.mapper';
import {
  AsaasCheckout,
  AsaasCustomer,
  AsaasList,
  AsaasPayment,
  AsaasRefund,
  AsaasSubscription,
  AsaasWebhookEvent,
} from './asaas.types';

/** Por quanto tempo o checkout hospedado aceita pagamento. */
const CHECKOUT_MINUTES_TO_EXPIRE = 60;

/** Fuso horário de negócio da aplicação (datas de cobrança em horário do Brasil). */
const APP_TIME_ZONE = 'America/Sao_Paulo';

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
  readonly name = 'asaas';
  /**
   * O Asaas exige CPF/CNPJ para criar o cliente. Telefone e endereço são
   * opcionais no cadastro dele, mas os pedimos para não arriscar a recusa do
   * cartão. A ordem é a da mensagem ao usuário.
   */
  readonly requiredCustomerFields: readonly CustomerProfileField[] = [
    'document',
    'phone',
    'postalCode',
    'street',
    'addressNumber',
    'neighborhood',
  ];

  private readonly logger = new Logger(AsaasPaymentProvider.name);
  private client?: AsaasHttpClient;

  constructor(private readonly config: ConfigService) {}

  async createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer> {
    try {
      // O `externalReference` do cliente é o id do usuário. Procurar antes de
      // criar é o que impede um segundo cliente quando a tentativa anterior
      // criou o primeiro e falhou antes de o id ser gravado aqui.
      const existing = await this.getClient().get<AsaasList<AsaasCustomer>>('/customers', {
        // Mais de um: um cliente removido pode vir na frente de um ativo.
        query: { externalReference: input.userId, limit: 10 },
      });
      const found = (existing.data ?? []).find((customer) => !customer.deleted);
      if (found) return { id: found.id };

      const customer = await this.getClient().post<AsaasCustomer>('/customers', {
        name: input.name,
        email: input.email,
        cpfCnpj: this.onlyDigits(input.document),
        // O Asaas espera apenas dígitos no telefone/CEP (sem máscara).
        mobilePhone: this.onlyDigits(input.phone),
        postalCode: this.onlyDigits(input.postalCode),
        address: input.street ?? undefined,
        addressNumber: input.addressNumber ?? undefined,
        complement: input.complement ?? undefined,
        province: input.neighborhood ?? undefined,
        externalReference: input.userId,
      });
      return { id: customer.id };
    } catch (error) {
      this.rethrowAsClientError(error, 'criar o cliente');
    }
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    let checkout: AsaasCheckout;
    try {
      checkout = await this.getClient().post<AsaasCheckout>('/checkouts', {
        billingTypes: ['CREDIT_CARD'],
        chargeTypes: ['RECURRENT'],
        minutesToExpire: CHECKOUT_MINUTES_TO_EXPIRE,
        customer: input.providerCustomerId,
        externalReference: input.externalReference,
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
          // Asaas exige a data da primeira cobrança para checkouts RECURRENT.
          // A cobrança efetiva ocorre quando o cliente conclui o checkout; usamos
          // a data de hoje (fuso da API) como primeiro vencimento.
          nextDueDate: this.today(),
        },
      });
    } catch (error) {
      this.rethrowAsClientError(error, 'abrir o checkout');
    }

    const checkoutUrl = checkout.link ?? checkout.url;
    if (!checkoutUrl) {
      throw new PaymentProviderError('unavailable', 'Asaas não retornou URL de checkout');
    }
    return {
      checkoutUrl,
      providerCheckoutId: checkout.id,
      expiresAt: new Date(Date.now() + CHECKOUT_MINUTES_TO_EXPIRE * 60 * 1000),
    };
  }

  async cancelSubscription(input: CancelSubscriptionInput): Promise<void> {
    // DELETE interrompe a geração de novas cobranças no Asaas. A regra de
    // acesso até o fim do período já pago é tratada na camada de domínio.
    try {
      await this.getClient().delete<unknown>(`/subscriptions/${input.providerSubscriptionId}`);
    } catch (error) {
      // Já removida: o objetivo (parar de cobrar) está cumprido. Sem isto, um
      // retry depois de um cancelamento que deu certo falharia para sempre.
      if (error instanceof PaymentProviderError && error.kind === 'not_found') return;
      throw error;
    }
  }

  async getSubscription(providerSubscriptionId: string): Promise<ProviderSubscription> {
    const sub = await this.getClient().get<AsaasSubscription>(
      `/subscriptions/${providerSubscriptionId}`,
    );
    return mapSubscription(sub);
  }

  async getPayment(providerPaymentId: string): Promise<ProviderPayment> {
    const payment = await this.getClient().get<AsaasPayment>(`/payments/${providerPaymentId}`);
    return mapPayment(payment);
  }

  async listSubscriptionPayments(providerSubscriptionId: string): Promise<ProviderPayment[]> {
    // O padrão do Asaas são 10 por página, da mais nova para a mais antiga, e
    // a lista inclui cobranças futuras já geradas. 20 cobre com folga as
    // vencidas recentes mesmo com duas futuras na frente.
    const list = await this.getClient().get<AsaasList<AsaasPayment>>(
      `/subscriptions/${providerSubscriptionId}/payments`,
      { query: { limit: 20 } },
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
      throw new PaymentProviderError('unavailable', 'ASAAS_WEBHOOK_TOKEN não configurado');
    }

    const provided =
      input.signature ?? (this.headerValue(input.headers, 'asaas-access-token') as string);
    if (!provided || !this.safeEqual(provided, expected)) {
      throw new PaymentProviderError('unauthorized', 'Assinatura de webhook do Asaas inválida');
    }

    const event = this.parseEvent(input.rawBody);
    if (!event.id || !event.event) {
      throw new PaymentProviderError('unauthorized', 'Payload de webhook do Asaas inválido');
    }

    return {
      provider: this.name,
      providerEventId: event.id,
      eventType: event.event,
      payload: event,
    };
  }

  normalizeWebhookEvent(event: VerifiedPaymentEvent): NormalizedWebhookEvent {
    return normalizeAsaasWebhookEvent(event.eventType, event.payload);
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  /**
   * Data de hoje (`YYYY-MM-DD`) no fuso da aplicação (America/Sao_Paulo). Usar
   * UTC aqui adiantaria um dia quando o checkout ocorre à noite no Brasil (≥21h),
   * pois já é o dia seguinte em UTC — resultando num primeiro vencimento errado.
   */
  private today(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: APP_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  /** Remove tudo que não for dígito (telefone, CEP, CPF/CNPJ mascarados). */
  private onlyDigits(value?: string | null): string | undefined {
    if (!value) return undefined;
    const digits = value.replace(/\D/g, '');
    return digits.length > 0 ? digits : undefined;
  }

  /**
   * Recusa de dados pelo Asaas vira `validation` com a(s) descrição(ões) dele
   * (sem segredos) — ex.: "O CPF/CNPJ informado é inválido." —, que o usuário
   * pode corrigir. As demais falhas sobem como vieram. Nunca loga corpos de
   * requisição.
   */
  private rethrowAsClientError(error: unknown, action: string): never {
    if (error instanceof AsaasApiError && error.kind === 'validation') {
      const description = this.extractAsaasErrors(error.body);
      this.logger.warn(`Asaas recusou ${action} (HTTP ${error.status}): ${description ?? '—'}`);
      throw new PaymentProviderError(
        'validation',
        description ?? `Não foi possível ${action}. Verifique os dados informados.`,
        { cause: error, userFacing: true },
      );
    }
    throw error;
  }

  /** Extrai as descrições de erro do corpo padrão do Asaas (`{ errors: [...] }`). */
  private extractAsaasErrors(body: unknown): string | undefined {
    if (body && typeof body === 'object' && 'errors' in body) {
      const errors = (body as { errors?: Array<{ description?: string }> }).errors;
      if (Array.isArray(errors)) {
        const messages = errors.map((e) => e?.description).filter((d): d is string => !!d);
        if (messages.length > 0) return messages.join('; ');
      }
    }
    return undefined;
  }

  private getClient(): AsaasHttpClient {
    if (this.client) return this.client;

    const baseUrl = this.config.get<string>('ASAAS_API_URL');
    const apiKey = this.config.get<string>('ASAAS_API_KEY');
    if (!baseUrl || !apiKey) {
      throw new PaymentProviderError('unavailable', 'Credenciais do Asaas não configuradas');
    }

    this.client = new AsaasHttpClient({ baseUrl, apiKey });
    return this.client;
  }

  private parseEvent(rawBody: Buffer | string): AsaasWebhookEvent {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    try {
      return JSON.parse(text) as AsaasWebhookEvent;
    } catch {
      throw new PaymentProviderError('unauthorized', 'Corpo do webhook do Asaas não é JSON válido');
    }
  }

  private headerValue(headers: VerifyWebhookInput['headers'], name: string): string | undefined {
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
