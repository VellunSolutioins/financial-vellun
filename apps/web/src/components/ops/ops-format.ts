/** Formatações compartilhadas pelas telas de operações. */

const EM_BRANCO = '—';

/** Data e hora curtas, no formato que o resto do app já usa. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return EM_BRANCO;
  return new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Idade legível: "há 3 dias", "há 2 h", "agora".
 *
 * O painel pergunta com frequência *há quanto tempo isto está assim* — e a
 * resposta em data absoluta obriga o operador a fazer a subtração de cabeça.
 */
export function formatAge(value: string | null | undefined, now = Date.now()): string {
  if (!value) return EM_BRANCO;

  const ms = now - new Date(value).getTime();
  if (Number.isNaN(ms)) return EM_BRANCO;
  if (ms < 60_000) return 'agora';

  const minutos = Math.floor(ms / 60_000);
  if (minutos < 60) return `há ${minutos} min`;

  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `há ${horas} h`;

  const dias = Math.floor(horas / 24);
  return `há ${dias} ${dias === 1 ? 'dia' : 'dias'}`;
}

/** JSON legível para exibição. Nunca lança: o payload vem de fora. */
export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return '[não foi possível serializar]';
  }
}
