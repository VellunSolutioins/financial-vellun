/**
 * Constantes da área de operações.
 *
 * O cookie e o segredo são **deliberadamente distintos** dos do produto: um
 * `access_token` de cliente nunca é aceito em `/ops/*`, e uma sessão de operador
 * nunca vale nas rotas do produto. A separação é de identidade, não de papel —
 * `ops_operators` é outra tabela, sem caminho de código a partir de `users`.
 */

/** Cookie da sessão de operador. Precisa constar no {@link CsrfGuard}. */
export const OPS_SESSION_COOKIE = 'ops_session';

/** Cookie de `state` do OAuth, comparado no callback. Vida curta. */
export const OPS_OAUTH_STATE_COOKIE = 'ops_oauth_state';

/** Claim que marca o token como de operações. Ver {@link OpsSessionService}. */
export const OPS_TOKEN_TYPE = 'ops';

/**
 * TTL da sessão. Curto de propósito: a área move dinheiro e reprocessa
 * mensagens. A renovação deslizante (ver {@link OpsAuthGuard}) evita que o
 * operador seja derrubado no meio de uma investigação.
 */
export const OPS_SESSION_TTL_SECONDS = 30 * 60;

/**
 * Prazo absoluto de uma sessão, contado do login. A renovação deslizante não
 * passa daqui: sem ele, uma sessão usada com frequência nunca expirava, e quem
 * saiu da organização continuava dentro enquanto mantivesse o painel aberto.
 */
export const OPS_SESSION_ABSOLUTE_TTL_SECONDS = 12 * 60 * 60;

/** A partir de quanto do TTL restante a sessão é reemitida. */
export const OPS_SESSION_RENEW_THRESHOLD_SECONDS = 15 * 60;

/** TTL do cookie de `state` do OAuth: o tempo de um login, não mais. */
export const OPS_OAUTH_STATE_TTL_SECONDS = 10 * 60;

/** Escopo mínimo para verificar pertencimento à organização. */
export const GITHUB_OAUTH_SCOPE = 'read:org';

/** Ações registradas em `ops_audit_log`. Strings estáveis: são consultadas. */
export const OPS_AUDIT_ACTIONS = {
  loginSucceeded: 'ops.login.succeeded',
  loginDenied: 'ops.login.denied',
  operatorPromoted: 'ops.operator.updated',
  sensitiveViewed: 'ops.failure.sensitive_viewed',
  failureReprocessRequested: 'ops.failure.reprocess_requested',
  failureReprocessPublished: 'ops.failure.reprocess_published',
  failureDiscarded: 'ops.failure.discarded',
  paymentEventRecovered: 'ops.payment_event.recovered',
} as const;

/** Tipos de alvo usados em `ops_audit_log.targetType`. */
export const OPS_AUDIT_TARGETS = {
  operator: 'ops_operator',
  failedMessage: 'ops_failed_message',
  paymentWebhookEvent: 'payment_webhook_event',
} as const;
