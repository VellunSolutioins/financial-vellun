import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Formata uma data (ISO ou "YYYY-MM-DD") em pt-BR **em UTC**.
 *
 * Datas de lançamento são "date-only" gravadas em UTC; formatar no fuso local
 * do navegador (ex.: America/Sao_Paulo) deslocaria o dia-calendário para trás
 * (01/06 → 31/05). Usar `timeZone: 'UTC'` mantém o dia correto.
 */
export function formatDateBR(value: string | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Date(value).toLocaleDateString('pt-BR', { timeZone: 'UTC', ...options });
}
