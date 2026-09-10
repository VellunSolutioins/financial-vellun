/**
 * Contratos de leitura do painel de operações.
 *
 * As datas chegam como **string ISO**, não `Date`: é o que o JSON transporta, e
 * tipar como `Date` faria o TypeScript concordar com um `toLocaleString` que só
 * quebraria em execução.
 */

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type OpsFailureStatus = 'pending' | 'reprocessing' | 'reprocessed' | 'discarded';
export type OpsFailureSource = 'whatsapp_inbound' | 'whatsapp_processing';
export type WebhookEventStatus = 'received' | 'processing' | 'processed' | 'failed';
export type OpsAuditResult = 'success' | 'failure' | 'denied';

export interface FailureListItem {
  id: string;
  source: OpsFailureSource;
  sourceQueue: string;
  status: OpsFailureStatus;
  errorType: string;
  errorMessage: string;
  attempts: number;
  permanent: boolean;
  correlationId: string | null;
  phoneHash: string | null;
  firstFailedAt: string | null;
  failedAt: string;
  capturedAt: string;
}

export interface FailureDetail extends FailureListItem {
  providerMessageId: string | null;
  jobId: string | null;
  payload: unknown;
  /** `false` quando o payload veio mascarado. A tela precisa dizer isso. */
  sensitiveRevealed: boolean;
  reprocessedAt: string | null;
  retentionUntil: string;
  /** Explore do Grafana filtrado pela correlação; `null` se não configurado. */
  logsUrl: string | null;
}

export interface PaymentEventListItem {
  id: string;
  providerEventId: string;
  eventType: string;
  status: WebhookEventStatus;
  attempts: number;
  receivedAt: string;
  processedAt: string | null;
  lastError: string | null;
}

export interface PaymentEventDetail extends PaymentEventListItem {
  payload: unknown;
  sensitiveRevealed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  reason: string | null;
  result: OpsAuditResult;
  operationId: string;
  createdAt: string;
  operator: { id: string; githubLogin: string };
}

export interface AuditEntryDetail extends AuditEntry {
  beforeState: unknown;
  afterState: unknown;
}

export interface OpsOverview {
  failures: {
    byStatus: Record<OpsFailureStatus, number>;
    last24h: number;
    oldestPendingAt: string | null;
    topErrorTypes: { errorType: string; count: number }[];
  };
  payments: {
    byStatus: Record<WebhookEventStatus, number>;
    last24hFailed: number;
    oldestUnresolvedAt: string | null;
  };
  grafana: { dashboards: { key: string; label: string; url: string }[] };
  generatedAt: string;
}

// ── Rótulos ─────────────────────────────────────────────────────────────────
//
// Em português e em um lugar só: os mesmos status aparecem no resumo, na lista e
// no detalhe, e traduzir em cada tela é como as três acabam discordando.

export const failureStatusLabels: Record<OpsFailureStatus, string> = {
  pending: 'Pendente',
  reprocessing: 'Reprocessando',
  reprocessed: 'Reprocessada',
  discarded: 'Descartada',
};

export const failureSourceLabels: Record<OpsFailureSource, string> = {
  whatsapp_inbound: 'Entrada',
  whatsapp_processing: 'Processamento',
};

export const paymentStatusLabels: Record<WebhookEventStatus, string> = {
  received: 'Recebido',
  processing: 'Processando',
  processed: 'Processado',
  failed: 'Falhou',
};

export const auditResultLabels: Record<OpsAuditResult, string> = {
  success: 'Sucesso',
  failure: 'Falha',
  denied: 'Negada',
};

/**
 * Rótulos das ações da trilha. As chaves espelham `OPS_AUDIT_ACTIONS` na API —
 * são strings estáveis justamente para poderem ser consultadas e traduzidas.
 */
export const auditActionLabels: Record<string, string> = {
  'ops.login.succeeded': 'Login',
  'ops.login.denied': 'Login negado',
  'ops.operator.updated': 'Permissões alteradas',
  'ops.failure.sensitive_viewed': 'Payload em claro visualizado',
  'ops.failure.reprocess_requested': 'Reprocessamento solicitado',
  'ops.failure.reprocess_published': 'Mensagem republicada',
  'ops.failure.discarded': 'Falha descartada',
  'ops.payment_event.recovered': 'Evento de pagamento recuperado',
};

export const auditTargetLabels: Record<string, string> = {
  ops_operator: 'Operador',
  ops_failed_message: 'Falha',
  payment_webhook_event: 'Webhook de pagamento',
};
