/**
 * Funcionalidades do app controladas por feature flag global (painel /ops).
 *
 * Só o tipo vive aqui: a API consome este pacote com `import type`, e um valor
 * em runtime não chegaria ao `dist/` dela. O catálogo (rótulo, descrição,
 * default) fica na API, e o mapa de rotas fica no web — ambos tipados por esta
 * união, então esquecer um dos lados não compila.
 */
export type FeatureKey = 'agenda' | 'notes';

/** Estado de cada flag como o app recebe de `GET /features`. */
export type FeatureFlags = Record<FeatureKey, boolean>;
