import { ApiClientError } from '@/lib/api-client';
import { FIELD_ORDER, type SignupField } from './signup-schema';

const GENERIC_ERROR = 'Ocorreu um erro. Tente novamente.';

/**
 * Mensagens de um erro de chamada à API, uma por item. Falha de rede ou
 * resposta inesperada vira a mensagem genérica.
 */
export function apiErrorMessages(error: unknown): string[] {
  if (!(error instanceof ApiClientError)) return [GENERIC_ERROR];
  const messages = error.messages.filter(Boolean);
  return messages.length > 0 ? messages : [GENERIC_ERROR];
}

export interface MappedServerErrors {
  /** Primeira mensagem de cada campo do formulário. */
  fields: Partial<Record<SignupField, string>>;
  /** O que não pertence a campo nenhum do formulário. */
  general: string[];
}

function isSignupField(field: string): field is SignupField {
  return (FIELD_ORDER as readonly string[]).includes(field);
}

/**
 * Separa um erro do cadastro entre os campos do formulário e o alerta geral,
 * pelo campo que a própria API informa (`errors: [{ field, message }]`). Sem
 * essa informação, nada é adivinhado: a mensagem vai inteira para o alerta.
 */
export function mapSignupErrors(error: unknown): MappedServerErrors {
  const mapped: MappedServerErrors = { fields: {}, general: [] };
  if (!(error instanceof ApiClientError) || error.fieldErrors.length === 0) {
    mapped.general = apiErrorMessages(error);
    return mapped;
  }

  for (const { field, message } of error.fieldErrors) {
    if (!isSignupField(field)) mapped.general.push(message);
    else if (!mapped.fields[field]) mapped.fields[field] = message;
  }
  return mapped;
}
