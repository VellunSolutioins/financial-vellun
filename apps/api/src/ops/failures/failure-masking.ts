/**
 * Mascaramento do que a listagem e o detalhe de falhas devolvem.
 *
 * O `payload` guardado é **íntegro** — precisa ser, senão o reprocessamento
 * republicaria uma mensagem adulterada. A proteção, portanto, não está no
 * armazenamento: está aqui, na leitura. Todo caminho que devolve uma falha passa
 * por `maskFailurePayload`, e o conteúdo em claro só sai para operador com
 * `canViewSensitive` — com linha de auditoria por visualização.
 */

/** Campos que carregam o número de telefone nos contratos do pipeline. */
const PHONE_KEYS = new Set(['phone', 'phoneNumber', 'from', 'to']);

/** Campos que carregam o que o usuário escreveu ou o agente respondeu. */
const CONTENT_KEYS = new Set([
  'text',
  'caption',
  'combinedMessage',
  'message',
  'rawInput',
  'responsePrefix',
  'confirmQuestion',
  'transcript',
]);

const MAX_DEPTH = 8;

/**
 * Mascara o telefone preservando DDI/DDD e os dois últimos dígitos.
 *
 * O suficiente para o operador reconhecer o número numa investigação — e para
 * confirmar com o cliente — sem que o número inteiro apareça na tela.
 */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 6) return '***';

  return `${digits.slice(0, 4)}${'*'.repeat(Math.max(digits.length - 6, 1))}${digits.slice(-2)}`;
}

/**
 * Resume o conteúdo em vez de escondê-lo por completo.
 *
 * Esconder tudo tornaria o painel inútil: "gastei 47,50 no mercado" é
 * exatamente o que diz se a falha é de parsing ou de infraestrutura. Devolvemos o
 * tamanho e as primeiras palavras, que respondem essa pergunta sem despejar o
 * lançamento financeiro inteiro na tela.
 */
export function maskContent(value: string): string {
  const limpo = value.trim();
  if (limpo.length <= 12) return `[${limpo.length} caracteres]`;

  return `${limpo.slice(0, 12)}… [${limpo.length} caracteres]`;
}

/**
 * Copia o payload aplicando as máscaras. Devolve cópia, nunca muta o original —
 * o payload é o que será republicado, e alterá-lo aqui corromperia o
 * reprocessamento.
 */
export function maskFailurePayload(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCADO]';

  if (Array.isArray(value)) {
    return value.map((item) => maskFailurePayload(item, depth + 1));
  }

  if (value && typeof value === 'object') {
    const resultado: Record<string, unknown> = {};
    for (const [chave, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === 'string' && PHONE_KEYS.has(chave)) {
        resultado[chave] = maskPhone(item);
        continue;
      }
      if (typeof item === 'string' && CONTENT_KEYS.has(chave)) {
        resultado[chave] = maskContent(item);
        continue;
      }
      resultado[chave] = maskFailurePayload(item, depth + 1);
    }
    return resultado;
  }

  return value;
}
