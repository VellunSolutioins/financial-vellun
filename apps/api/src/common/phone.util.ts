/**
 * Normaliza um telefone para o formato canônico E.164 usado no vínculo de
 * WhatsApp (`whatsapp_contacts.phone_number`), ex.: `+5519993987410`.
 *
 * Aceita qualquer entrada (mascarada `(19) 99398-7410`, só dígitos
 * `19993987410`, ou já em E.164 `+5519993987410`) e assume DDI brasileiro
 * (`55`) quando o número vem apenas com DDD + número.
 */
export function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (!digits) return '';

  // 10 dígitos (DDD + fixo) ou 11 (DDD + celular): sem DDI → assume Brasil.
  if (digits.length === 10 || digits.length === 11) {
    return `+55${digits}`;
  }

  // 12/13 dígitos começando com 55: já tem DDI brasileiro.
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
    return `+${digits}`;
  }

  // Demais casos (internacional ou formato desconhecido): preserva os dígitos.
  return `+${digits}`;
}

/**
 * Formas equivalentes de um número brasileiro em E.164, com e sem o nono
 * dígito do celular. A Meta ainda entrega parte dos celulares no formato antigo
 * (`+55 19 9398-7410`), então o número que o usuário digita e o que chega no
 * webhook podem diferir só nesse dígito.
 *
 * Devolve o próprio número primeiro. Números que não são celulares brasileiros
 * voltam sozinhos.
 */
export function phoneVariants(e164: string): string[] {
  const match = /^\+55(\d{2})(\d{8,9})$/.exec(e164);
  if (!match) return e164 ? [e164] : [];

  const [, ddd, subscriber] = match;
  if (subscriber.length === 9 && subscriber.startsWith('9')) {
    return [e164, `+55${ddd}${subscriber.slice(1)}`];
  }
  // Formato antigo: 8 dígitos começando por 6-9 é celular sem o nono dígito.
  if (subscriber.length === 8 && /^[6-9]/.test(subscriber)) {
    return [e164, `+55${ddd}9${subscriber}`];
  }
  return [e164];
}
