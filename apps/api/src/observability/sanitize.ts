/**
 * Redação de dado sensível em log e resposta de erro.
 *
 * Complementa `sanitizePayload` do billing (que protege o que é **persistido**);
 * aqui o alvo é o que é **emitido** — linha de log e corpo de exceção. Os dois
 * caminhos vazam de formas diferentes e precisam dos dois filtros.
 */

/** Chaves cujo valor nunca aparece. Superset do usado no billing. */
const SENSITIVE_KEY =
  /(card|ccv|cvv|cvc|token|secret|password|passwordhash|authorization|cookie|apikey|api_key|access_token|refresh_token)/i;

/** Chaves de identificador pessoal: aparecem mascaradas, não redigidas. */
const PERSONAL_KEY = /^(phone|phonenumber|telefone|email|cpf|cnpj|document)$/i;

export const REDACTED = '[REDACTED]';

/** Profundidade máxima: um payload cíclico ou muito fundo não deve travar o log. */
const MAX_DEPTH = 6;

/**
 * Mascara um telefone preservando DDI/DDD e os dois últimos dígitos.
 *
 * O suficiente para reconhecer o número numa investigação sem registrá-lo — e é
 * o mesmo compromisso que o agente de IA já faz (`mask_phone`).
 */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  // Com menos de quatro dígitos para esconder, preservar começo e fim revela o
  // número (ou quase): seis dígitos saíam inteiros.
  if (digits.length < 10) return REDACTED;

  const prefix = digits.slice(0, 4);
  const suffix = digits.slice(-2);
  return `${prefix}${'*'.repeat(digits.length - 6)}${suffix}`;
}

/** Mascara um e-mail preservando o domínio e a primeira letra. */
export function maskEmail(value: string): string {
  const at = value.indexOf('@');
  if (at <= 0) return REDACTED;

  const local = value.slice(0, at);
  const domain = value.slice(at);
  return `${local[0]}${'*'.repeat(Math.max(local.length - 1, 1))}${domain}`;
}

function maskPersonal(key: string, value: string): string {
  if (/email/i.test(key)) return maskEmail(value);
  return maskPhone(value);
}

/**
 * Copia a estrutura redigindo o que é sensível.
 *
 * Devolve uma cópia em vez de mutar: o objeto original costuma ser o payload que
 * a aplicação ainda vai usar, e sanitizar por mutação já causou bug de "sumiu o
 * dado depois de logar" em mais de um projeto.
 */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED]';

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, depth + 1));
  }

  if (value instanceof Date) return value.toISOString();

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) {
        result[key] = REDACTED;
        continue;
      }
      if (PERSONAL_KEY.test(key) && typeof item === 'string') {
        result[key] = maskPersonal(key, item);
        continue;
      }
      result[key] = sanitizeForLog(item, depth + 1);
    }
    return result;
  }

  return value;
}
