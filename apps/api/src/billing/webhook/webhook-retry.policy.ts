/**
 * Política de retry dos webhooks de pagamento.
 *
 * Antes, o backoff era `2^n * 500ms` — cinco tentativas em ~7,5 s, todas dentro
 * do mesmo processo. Duas coisas mudaram junto com a durabilidade:
 *
 * 1. **Os intervalos são de banco, não de memória.** O agendamento vive em
 *    `next_retry_at` e é varrido por um cron de minuto em minuto, então esperar
 *    500 ms não faz sentido: a próxima varredura não chegaria a tempo.
 * 2. **A escala mudou de propósito.** As falhas reais aqui são indisponibilidade
 *    do PSP e queda do banco — coisas que levam minutos, não milissegundos.
 *    Cinco tentativas em 7,5 s esgotavam o evento antes de o problema ter
 *    qualquer chance de passar.
 *
 * Buckets explícitos em vez de fórmula: dá para ler a tabela e saber quando a
 * quinta tentativa acontece, sem calcular potência de dois.
 */
export const RETRY_BUCKETS_SECONDS = [30, 120, 600, 1800, 7200] as const;

/** Tentativas antes de o evento virar `exhausted`. */
export const MAX_ATTEMPTS = RETRY_BUCKETS_SECONDS.length;

/**
 * Quando tentar de novo, dado o número de tentativas já feitas.
 *
 * `null` significa **esgotado**: não há próxima tentativa, e quem chama deve
 * gravar `exhausted`. Devolver uma data aqui e decidir o esgotamento noutro
 * lugar deixaria as duas decisões livres para discordar.
 */
export function nextRetryAt(attempts: number, from: Date = new Date()): Date | null {
  if (attempts >= MAX_ATTEMPTS) return null;

  // `attempts` conta as tentativas JA feitas (`markProcessing` incrementa antes
  // de tentar), entao a primeira falha chega aqui com 1 e usa o bucket 0.
  const indice = Math.max(attempts - 1, 0);
  return new Date(from.getTime() + RETRY_BUCKETS_SECONDS[indice] * 1000);
}

/** Janela total coberta pelas tentativas, para documentação e alerta. */
export function totalRetryWindowSeconds(): number {
  return RETRY_BUCKETS_SECONDS.reduce((soma, bucket) => soma + bucket, 0);
}
