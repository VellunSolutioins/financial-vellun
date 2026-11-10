import type { FeatureFlags, FeatureKey } from '@financial-vellun/shared';

import { apiClient } from './api-client';

export type { FeatureFlags, FeatureKey };

/**
 * Rotas de cada funcionalidade com feature flag (ligada/desligada no /ops).
 *
 * Desligada, qualquer rota que comece por um destes prefixos sai para o
 * dashboard — inclusive subrotas e redirecionamentos antigos como `lembretes`.
 * O `Record` obriga a mapear toda `FeatureKey` nova.
 */
export const FEATURE_ROUTES: Record<FeatureKey, string[]> = {
  agenda: ['/app/pessoal/agenda', '/app/pessoal/lembretes'],
  notes: ['/app/pessoal/anotacoes'],
};

/** Funcionalidade dona da rota, ou `null` para rotas essenciais (sempre disponíveis). */
export function featureForPath(pathname: string): FeatureKey | null {
  for (const [feature, prefixes] of Object.entries(FEATURE_ROUTES) as [FeatureKey, string[]][]) {
    if (prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
      return feature;
    }
  }
  return null;
}

/** Todas desligadas: o estado seguro quando não foi possível consultar a API. */
export function allFeaturesOff(): FeatureFlags {
  return Object.fromEntries(Object.keys(FEATURE_ROUTES).map((key) => [key, false])) as FeatureFlags;
}

export const getFeatures = () => apiClient.get<FeatureFlags>('/features');
