import { OpsFailureSource } from '@prisma/client';

/**
 * Rotas lógicas que o agente aceita em `POST /internal/ops/reprocess`.
 *
 * São os mesmos nomes de `ROUTE_INBOUND`/`ROUTE_PROCESSING`/`ROUTE_OUTBOUND` em
 * `apps/ai-agent/src/messaging/base.py`. O nome **físico** da fila e a exchange
 * continuam saindo da configuração do agente — nunca trafegam por aqui.
 */
export type ReprocessRoute = 'inbound' | 'processing' | 'outbound';

/**
 * Allowlist de destino do reprocessamento.
 *
 * A chave é o `source` da falha, que é um **enum do banco** — não o
 * `sourceQueue` nem o `routingKey`, que são colunas de texto preenchidas a
 * partir do envelope da DLQ. A diferença importa: texto vindo de uma mensagem
 * pode ser manipulado por quem consegue publicar na DLQ, enquanto o enum só
 * assume os valores que o Postgres aceita.
 *
 * Nada disso vem do navegador. O pedido do operador carrega o **id da falha** e
 * uma justificativa; o destino é derivado aqui, no servidor.
 */
const DESTINOS: Record<OpsFailureSource, ReprocessRoute> = {
  whatsapp_inbound: 'inbound',
  whatsapp_processing: 'processing',
  whatsapp_outbound: 'outbound',
};

export function routeForSource(source: OpsFailureSource): ReprocessRoute {
  const rota = DESTINOS[source];
  if (!rota) {
    // Inalcançável enquanto o enum e o mapa andarem juntos; existe para que
    // acrescentar um `source` sem acrescentar o destino falhe alto.
    throw new Error(`Origem sem destino de reprocessamento: ${source}`);
  }
  return rota;
}
