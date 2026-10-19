/**
 * O que deu errado no PSP, em termos que o domínio sabe tratar:
 *
 * - `validation`: o PSP recusou os dados enviados (CPF inválido, endereço
 *   incompleto). A mensagem pode ser mostrada ao usuário.
 * - `not_found`: o PSP não conhece o recurso pedido.
 * - `unauthorized`: a chamada **ao nosso** webhook não se autenticou.
 * - `unavailable`: o PSP não respondeu, respondeu erro interno, ou falta
 *   configuração para falar com ele. Vale tentar de novo depois.
 * - `not_supported`: o PSP não oferece a operação.
 */
export type PaymentProviderErrorKind =
  | 'validation'
  | 'not_found'
  | 'unauthorized'
  | 'unavailable'
  | 'not_supported';

/**
 * Único erro que atravessa o contrato do PSP. O adapter não deixa sair nem
 * exceção HTTP do Nest (que amarraria o adapter ao transporte) nem erro próprio
 * do PSP (que obrigaria o domínio a conhecer um PSP específico).
 */
export class PaymentProviderError extends Error {
  // O `target` da API é ES2021: o `Error` do lib ainda não tem `cause`.
  /** Erro original do PSP, para log e diagnóstico. */
  readonly cause?: unknown;
  /**
   * A mensagem foi escrita para o usuário (ex.: a descrição do PSP sobre o CPF
   * recusado). Sem isto, ela é técnica — método, rota, status — e não sai na
   * resposta HTTP.
   */
  readonly userFacing: boolean;

  constructor(
    public readonly kind: PaymentProviderErrorKind,
    message: string,
    options?: { cause?: unknown; userFacing?: boolean },
  ) {
    super(message);
    this.name = 'PaymentProviderError';
    this.cause = options?.cause;
    this.userFacing = options?.userFacing ?? false;
  }
}
