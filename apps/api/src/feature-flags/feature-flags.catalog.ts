import type { FeatureKey } from '@financial-vellun/shared';

export interface FeatureDefinition {
  /** Nome como aparece no menu do app. */
  label: string;
  /** O que o operador desliga ao desmarcar a flag. */
  description: string;
  /** Estado enquanto ninguém mexeu na flag (sem linha em `feature_flags`). */
  defaultEnabled: boolean;
}

/**
 * Funcionalidades do app que podem ser desligadas pelo /ops.
 *
 * Os itens essenciais do menu (Dashboard, Lançamentos, Recorrências,
 * Parcelamentos, Faturas, Metas, Cartões, Contas, Categorias) **não** entram
 * aqui: ficam sempre disponíveis. O `satisfies` obriga o catálogo a ter uma
 * entrada para cada `FeatureKey` — uma flag nova no tipo compartilhado não
 * compila sem rótulo e default.
 */
export const FEATURE_CATALOG = {
  agenda: {
    label: 'Agenda e Lembretes',
    description: 'Eventos da agenda e lembretes de contas a pagar.',
    defaultEnabled: true,
  },
  notes: {
    label: 'Anotações',
    description: 'Bloco de anotações livres do usuário.',
    defaultEnabled: true,
  },
} as const satisfies Record<FeatureKey, FeatureDefinition>;

export const FEATURE_KEYS = Object.keys(FEATURE_CATALOG) as FeatureKey[];

export function isFeatureKey(value: string): value is FeatureKey {
  return Object.prototype.hasOwnProperty.call(FEATURE_CATALOG, value);
}
