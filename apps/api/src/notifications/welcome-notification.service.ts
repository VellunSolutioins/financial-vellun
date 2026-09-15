import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { correlationHeaders } from '../observability/correlation';

export interface WelcomeNotificationParams {
  /** Telefone em E.164 (ex.: `+5519993987410`). */
  phone: string;
  name: string;
  profileType: string;
}

/**
 * Dispara a mensagem de boas-vindas ao novo cliente pelo agente de IA (que é
 * quem detém o canal WhatsApp). É **best-effort**: nunca lança nem bloqueia o
 * fluxo de cadastro — falhas são apenas logadas.
 */
@Injectable()
export class WelcomeNotificationService {
  private readonly logger = new Logger(WelcomeNotificationService.name);
  private readonly agentUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs = 10_000;

  constructor(config: ConfigService) {
    this.agentUrl = (config.get<string>('AI_AGENT_URL') ?? 'http://localhost:8010').replace(
      /\/+$/,
      '',
    );
    this.apiKey = config.getOrThrow<string>('INTERNAL_API_KEY');
  }

  /** Envia (best-effort) as boas-vindas. Resolve sempre, mesmo em falha. */
  async sendWelcome(params: WelcomeNotificationParams): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.agentUrl}/internal/notifications/welcome`, {
        method: 'POST',
        headers: {
          'x-internal-api-key': this.apiKey,
          'Content-Type': 'application/json',
          // Propaga a correlação: o cadastro na API e a mensagem enviada pelo
          // agente passam a aparecer no Loki sob o mesmo id.
          ...correlationHeaders(),
        },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger.warn(
          `Agente de IA recusou boas-vindas (HTTP ${response.status}) para ${params.phone}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Falha ao enviar boas-vindas para ${params.phone}: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
