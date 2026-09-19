/**
 * Mascaramento do que a listagem e o detalhe de falhas devolvem.
 *
 * O `payload` guardado é **íntegro** — precisa ser, senão o reprocessamento
 * republicaria uma mensagem adulterada. A proteção, portanto, não está no
 * armazenamento: está aqui, na leitura. Todo caminho que devolve uma falha passa
 * por `maskFailurePayload`, e o conteúdo em claro só sai para operador com
 * `canViewSensitive` — com linha de auditoria por visualização.
 *
 * A política é de **lista de permissão**: só aparece em claro o que está
 * declarado como estrutural. Tudo o mais é mascarado por padrão. Uma lista de
 * bloqueio (mascarar só o que se sabe sensível) vazava qualquer campo novo ou
 * com outro nome — o `preExtractedIntent` do agente, por exemplo, chega em
 * snake_case, com `description`, `amount` e `account_name` que nenhuma chave
 * conhecida cobria.
 */

/**
 * Campos estruturais dos contratos do pipeline, devolvidos como estão.
 *
 * Identificadores, tipos, versões, contadores e datas: é o que permite
 * diagnosticar uma falha, e nenhum deles diz o que o usuário escreveu, quanto
 * gastou ou com quem fala. Incluir um campo aqui é decidir que ele não é
 * sensível — na dúvida, fica de fora e sai mascarado.
 */
const STRUCTURAL_KEYS = new Set([
  // InboundMessageV1
  'schemaVersion',
  'eventId',
  'provider',
  'providerMessageId',
  'kind',
  'mediaMime',
  'rawType',
  'providerTimestamp',
  'receivedAt',
  'correlationId',
  // ProcessingJobV1
  'jobId',
  'sourceMessageIds',
  'providerMessageIds',
  'firstReceivedAt',
  'lastReceivedAt',
  'attempt',
  'forceConfirm',
  // FinancialIntent (preExtractedIntent, em snake_case): a classificação, não o
  // lançamento
  'intent',
  'transaction_type',
  'confidence',
  'needs_confirmation',
]);

/** Campos que carregam o número de telefone nos contratos do pipeline. */
const PHONE_KEYS = new Set(['phone', 'phoneNumber', 'from', 'to']);

/**
 * Campos que carregam o que o usuário escreveu ou o agente respondeu. Saem como
 * prévia curta, e não só como tamanho, porque o começo do texto é o que diz se a
 * falha é de parsing ou de infraestrutura.
 */
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

/** Mínimo de dígitos escondidos para a máscara de telefone valer alguma coisa. */
const MIN_HIDDEN_PHONE_DIGITS = 4;

/**
 * Mascara o telefone preservando DDI/DDD e os dois últimos dígitos.
 *
 * O suficiente para o operador reconhecer o número numa investigação — e para
 * confirmar com o cliente — sem que o número inteiro apareça na tela. Número
 * curto demais para esconder ao menos quatro dígitos sai inteiramente oculto:
 * preservar seis dígitos de um valor com seis não é máscara.
 */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 6 + MIN_HIDDEN_PHONE_DIGITS) return '***';

  return `${digits.slice(0, 4)}${'*'.repeat(digits.length - 6)}${digits.slice(-2)}`;
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
 * Mascara um valor escalar conforme o campo que o contém. `chave` é `null` na
 * raiz; elementos de lista herdam a chave da lista.
 */
function maskScalar(chave: string | null, value: unknown): unknown {
  // Ausência e flags não carregam dado do usuário, e escondê-las tiraria do
  // operador a diferença entre "campo vazio" e "campo preenchido".
  if (value === null || value === undefined || typeof value === 'boolean') return value;

  if (chave !== null && STRUCTURAL_KEYS.has(chave)) return value;

  if (typeof value === 'string') {
    if (chave !== null && PHONE_KEYS.has(chave)) return maskPhone(value);
    if (chave !== null && CONTENT_KEYS.has(chave)) return maskContent(value);
    return `[${value.length} caracteres]`;
  }

  // Número fora da lista de permissão é potencialmente valor financeiro.
  if (typeof value === 'number') return '[número]';

  return '***';
}

/**
 * Copia o payload aplicando as máscaras. Devolve cópia, nunca muta o original —
 * o payload é o que será republicado, e alterá-lo aqui corromperia o
 * reprocessamento.
 */
export function maskFailurePayload(value: unknown): unknown {
  return mascarar(null, value, 0);
}

function mascarar(chave: string | null, value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCADO]';

  if (Array.isArray(value)) {
    return value.map((item) => mascarar(chave, item, depth + 1));
  }

  if (value && typeof value === 'object') {
    const resultado: Record<string, unknown> = {};
    for (const [filha, item] of Object.entries(value as Record<string, unknown>)) {
      resultado[filha] = mascarar(filha, item, depth + 1);
    }
    return resultado;
  }

  return maskScalar(chave, value);
}
