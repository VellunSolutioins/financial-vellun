import { apiClient } from './api-client';

export type VerificationStatus = 'none' | 'pending' | 'verified' | 'expired';

/** Desafio gerado pela API: o código que o usuário envia ao bot. */
export interface PhoneVerificationChallenge {
  status: 'pending';
  code: string;
  phone: string;
  expiresAt: string;
  /** Número do bot (só dígitos). `null` quando a API não tem o número configurado. */
  botNumber: string | null;
  /** Link `wa.me` com a mensagem já preenchida. */
  waLink: string | null;
  message: string;
}

export interface PhoneVerificationState {
  status: VerificationStatus;
  phone: string | null;
  expiresAt: string | null;
  linkedPhone: string | null;
  botNumber: string | null;
}

/**
 * Gera (ou regenera) o código de verificação. Sem `phone`, usa o telefone do
 * cadastro. Trocar um número já verificado exige `currentPassword`.
 */
export function startPhoneVerification(data: {
  phone?: string;
  currentPassword?: string;
}): Promise<PhoneVerificationChallenge> {
  return apiClient.post<PhoneVerificationChallenge>('/users/me/phone/verification', data);
}

export function getPhoneVerificationState(): Promise<PhoneVerificationState> {
  return apiClient.get<PhoneVerificationState>('/users/me/phone/verification');
}

/** `5511999999999` → `+55 (11) 99999-9999`, para exibir o número do bot. */
export function formatBotNumber(digits: string): string {
  const match = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digits);
  if (!match) return `+${digits}`;
  return `+55 (${match[1]}) ${match[2]}-${match[3]}`;
}
