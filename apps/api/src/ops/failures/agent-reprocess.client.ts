import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { API_TO_AGENT_KEY_ENV, outgoingInternalKey } from '../../common/internal-keys.util';

import { correlationHeaders } from '../../observability/correlation';
import { ReprocessRoute } from './reprocess-destinations';

/**
 * Desfecho de uma tentativa de republicação.
 *
 * A distinção entre `rejected` e `unknown` é o ponto inteiro deste cliente:
 *
 * - `published` — o agente confirmou com *publisher confirm* do broker;
 * - `rejected` — o agente **recusou antes de publicar** (payload que não valida
 *   contra o contrato). Nada entrou no broker, e isso é certeza: a linha do
 *   catálogo pode voltar para `pending` com segurança;
 * - `unknown` — não deu para saber. Broker sem confirm, agente fora, timeout de
 *   rede. Um confirm que não chega **não prova** que a publicação não aconteceu,
 *   então a linha fica em `reprocessing` e o cron de reconciliação decide depois.
 *
 * Tratar `unknown` como `rejected` republicaria a mesma mensagem numa segunda
 * tentativa; tratar como `published` esconderia uma mensagem que nunca foi.
 */
export type ReprocessOutcome =
  | { status: 'published' }
  | { status: 'rejected'; reason: string }
  | { status: 'unknown'; reason: string };

export interface ReprocessRequest {
  route: ReprocessRoute;
  payload: unknown;
  correlationId: string | null;
}

/**
 * Cliente de `POST /internal/ops/reprocess` no agente.
 *
 * O agente é quem detém a conexão com o RabbitMQ — a API não fala com o broker,
 * e duplicar a camada de mensageria em TypeScript significaria manter duas
 * implementações de *publisher confirm*, topologia e contratos.
 *
 * Este cliente **não** é best-effort: o resultado decide o estado de uma linha
 * do catálogo.
 */
@Injectable()
export class AgentReprocessClient {
  private readonly logger = new Logger(AgentReprocessClient.name);
  private readonly agentUrl: string;
  private readonly apiKey: string;

  /**
   * Curto de propósito. O confirm do broker é rápido quando o broker está de
   * pé; esperar mais só aumenta a janela de `unknown` de um lote inteiro.
   */
  private readonly timeoutMs = 15_000;

  constructor(config: ConfigService) {
    this.agentUrl = (config.get<string>('AI_AGENT_URL') ?? 'http://localhost:8010').replace(
      /\/+$/,
      '',
    );
    // Chave da direção API→agente (ou a antiga, durante a migração).
    this.apiKey = outgoingInternalKey(config, API_TO_AGENT_KEY_ENV);
  }

  async republish(request: ReprocessRequest): Promise<ReprocessOutcome> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.agentUrl}/internal/ops/reprocess`, {
        method: 'POST',
        headers: {
          'x-internal-api-key': this.apiKey,
          'Content-Type': 'application/json',
          // Mesma correlação da falha: a republicação e o processamento que vier
          // depois aparecem no Loki sob o id que o operador já tem na tela.
          ...correlationHeaders(),
        },
        body: JSON.stringify({
          route: request.route,
          message: request.payload,
          correlationId: request.correlationId ?? undefined,
        }),
        signal: controller.signal,
      });

      if (response.ok) return { status: 'published' };

      const detalhe = await this.readDetail(response);

      // 4xx é decisão do agente tomada ANTES de publicar — exceto 408 e 429, que
      // são "tente de novo", não "recusado".
      if (
        response.status >= 400 &&
        response.status < 500 &&
        ![408, 429].includes(response.status)
      ) {
        return {
          status: 'rejected',
          reason: `agente recusou (HTTP ${response.status}): ${detalhe}`,
        };
      }

      return { status: 'unknown', reason: `agente respondeu HTTP ${response.status}: ${detalhe}` };
    } catch (error) {
      const motivo = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Republicação sem desfecho conhecido: ${motivo}`);
      return { status: 'unknown', reason: `falha de comunicação com o agente: ${motivo}` };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Detalhe do erro, truncado: vai para a auditoria e para a tela. */
  private async readDetail(response: Response): Promise<string> {
    try {
      const texto = await response.text();
      return texto.slice(0, 300);
    } catch {
      return 'sem corpo';
    }
  }
}
