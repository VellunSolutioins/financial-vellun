import { maskPhone } from '../failures/failure-masking';

/**
 * Mascaramento do payload de webhook de pagamento na leitura.
 *
 * O `sanitizedPayload` já sai do ingest sem cartão nem segredo
 * (`WebhookEventService.sanitizePayload`), mas continua carregando **identidade
 * do cliente**: nome, e-mail, CPF/CNPJ, telefone. Isso é o que o operador quase
 * nunca precisa ver para diagnosticar um webhook — e é exatamente o que não deve
 * ficar exposto numa tela aberta o dia inteiro.
 *
 * Mesma regra das falhas: mascarado por padrão, em claro só para
 * `canViewSensitive`, com linha de auditoria por visualização.
 */

/** Campos de identidade pessoal nos contratos do PSP. */
const EMAIL_KEYS = new Set(['email', 'customerEmail']);
const DOCUMENT_KEYS = new Set(['cpfCnpj', 'cpf', 'cnpj', 'document', 'taxId']);
const NAME_KEYS = new Set(['name', 'customerName', 'holderName', 'payerName']);
const PHONE_KEYS = new Set(['phone', 'mobilePhone', 'phoneNumber']);

const MAX_DEPTH = 8;

/** Preserva a primeira letra e o domínio: reconhece sem revelar. */
export function maskEmail(value: string): string {
  const [local, dominio] = value.split('@');
  if (!dominio || local.length === 0) return '***';

  const visivel = local.slice(0, 1);
  return `${visivel}${'*'.repeat(Math.max(local.length - 1, 1))}@${dominio}`;
}

/** Preserva os dois últimos dígitos, o bastante para conferir com o cliente. */
export function maskDocument(value: string): string {
  const digitos = value.replace(/\D/g, '');
  if (digitos.length < 4) return '***';

  return `${'*'.repeat(digitos.length - 2)}${digitos.slice(-2)}`;
}

/** Primeiro nome inteiro, iniciais do resto — suficiente para reconhecer. */
export function maskName(value: string): string {
  const partes = value.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return '***';

  const [primeiro, ...resto] = partes;
  if (resto.length === 0) return primeiro;
  return `${primeiro} ${resto.map((parte) => `${parte.slice(0, 1)}.`).join(' ')}`;
}

/** Copia o payload aplicando as máscaras. Nunca muta o original. */
export function maskPaymentPayload(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCADO]';

  if (Array.isArray(value)) {
    return value.map((item) => maskPaymentPayload(item, depth + 1));
  }

  if (value && typeof value === 'object') {
    const resultado: Record<string, unknown> = {};
    for (const [chave, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === 'string') {
        if (EMAIL_KEYS.has(chave)) {
          resultado[chave] = maskEmail(item);
          continue;
        }
        if (DOCUMENT_KEYS.has(chave)) {
          resultado[chave] = maskDocument(item);
          continue;
        }
        if (NAME_KEYS.has(chave)) {
          resultado[chave] = maskName(item);
          continue;
        }
        if (PHONE_KEYS.has(chave)) {
          resultado[chave] = maskPhone(item);
          continue;
        }
      }
      resultado[chave] = maskPaymentPayload(item, depth + 1);
    }
    return resultado;
  }

  return value;
}
