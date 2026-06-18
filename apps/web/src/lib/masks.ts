/**
 * Máscaras e validações de campos — padrão único do projeto.
 * Ver CLAUDE.md › "Máscaras e Validações de Campos".
 *
 * Toda máscara é uma função pura `maskXxx(value: string) => string` aplicada via
 * `onChange` sobrescrito após o spread de `register` (react-hook-form):
 *
 *   {...register('campo')}
 *   onChange={(e) => {
 *     const masked = maskXxx(e.target.value)
 *     e.target.value = masked
 *     setValue('campo', masked, { shouldDirty: true })
 *   }}
 */

// ── Regex de validação (frontend Zod / backend class-validator) ────────────────

export const PHONE_REGEX = /^\(\d{2}\) \d{4,5}-\d{4}$/;
export const CEP_REGEX = /^\d{5}-?\d{3}$/;
export const CPF_REGEX = /^\d{3}\.\d{3}\.\d{3}-\d{2}$/;
export const CNPJ_REGEX = /^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/;
/** CPF **ou** CNPJ — usado em campos de "Documento". */
export const CPF_CNPJ_REGEX = /^(\d{3}\.\d{3}\.\d{3}-\d{2}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})$/;
/** Valor monetário em formato BR: `1.500,00`. */
export const CURRENCY_REGEX = /^\d{1,3}(\.\d{3})*(,\d{1,2})?$/;

// ── Máscaras ───────────────────────────────────────────────────────────────────

/** `(XX) XXXX-XXXX` (fixo) · `(XX) XXXXX-XXXX` (celular). */
export function maskPhone(value: string): string {
  const d = value.replace(/\D/g, '').slice(0, 11);
  if (d.length === 0) return '';
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

/** `XXXXX-XXX`. */
export function maskCep(value: string): string {
  const d = value.replace(/\D/g, '').slice(0, 8);
  if (d.length <= 5) return d;
  return `${d.slice(0, 5)}-${d.slice(5)}`;
}

/** `XXX.XXX.XXX-XX`. */
export function maskCpf(value: string): string {
  const d = value.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

/** `XX.XXX.XXX/XXXX-XX`. */
export function maskCnpj(value: string): string {
  const d = value.replace(/\D/g, '').slice(0, 14);
  if (d.length <= 2) return d;
  if (d.length <= 5) return `${d.slice(0, 2)}.${d.slice(2)}`;
  if (d.length <= 8) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5)}`;
  if (d.length <= 12) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8)}`;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

/** Aplica CPF até 11 dígitos; a partir daí, CNPJ. */
export function maskCpfCnpj(value: string): string {
  const d = value.replace(/\D/g, '');
  return d.length <= 11 ? maskCpf(value) : maskCnpj(value);
}

/**
 * Valor monetário BR a partir dos dígitos digitados, tratados como centavos:
 * `"1500"` → `"15,00"`, `"150000"` → `"1.500,00"`.
 */
export function maskCurrency(value: string): string {
  const d = value.replace(/\D/g, '');
  if (!d) return '';
  return (Number(d) / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// ── Conversões para/da API ─────────────────────────────────────────────────────

/** Formata um número (vindo da API) para exibição no input: `1500` → `"1.500,00"`. */
export function formatCurrencyInput(value: number): string {
  return value.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Converte o valor mascarado para número enviado à API: `"1.500,00"` → `1500`. */
export function currencyToNumber(masked: string): number {
  const normalized = masked.replace(/\./g, '').replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}
