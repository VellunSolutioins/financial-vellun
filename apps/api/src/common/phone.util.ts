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
