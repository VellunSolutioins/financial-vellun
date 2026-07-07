import { timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
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
  NormalizedWebhookEvent,
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
  private readonly logger = new Logger(AsaasPaymentProvider.name);
  private client?: AsaasHttpClient;

  constructor(private readonly config: ConfigService) {}

  async createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer> {
    try {
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
   * Converte um erro do Asaas em uma exceção apropriada para o cliente. Erros de
   * validação (4xx) viram `BadRequestException` com a(s) descrição(ões) do Asaas
   * (sem segredos) — ex.: "O CPF/CNPJ informado é inválido." Demais erros sobem
   * como estão (viram 5xx). Nunca loga corpos de requisição.
   */
  private rethrowAsClientError(error: unknown, action: string): never {
    if (error instanceof AsaasApiError && error.status >= 400 && error.status < 500) {
      const description = this.extractAsaasErrors(error.body);
      this.logger.warn(`Asaas recusou ${action} (HTTP ${error.status}): ${description ?? '—'}`);
      throw new BadRequestException(
        description ?? `Não foi possível ${action}. Verifique os dados informados.`,
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
