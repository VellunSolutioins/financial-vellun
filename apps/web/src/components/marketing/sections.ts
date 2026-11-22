/** Seções da home com âncora. Cabeçalho, menu e rodapé usam esta mesma lista. */
export const HOME_SECTIONS = [
  { id: 'como-funciona', label: 'Como funciona' },
  { id: 'recursos', label: 'Recursos' },
  { id: 'duvidas', label: 'Dúvidas' },
] as const;

export type HomeSectionId = (typeof HOME_SECTIONS)[number]['id'];

/**
 * Rotas da landing: a versão atual em `/` e a nova em `/v2`, publicadas lado a
 * lado para comparação. Cabeçalho, rodapé e logo de cada uma apontam para ela
 * mesma.
 */
export type HomePath = '/' | '/v2';
export const HOME_PATHS: readonly string[] = ['/', '/v2'];

/** `/#id` (ou `/v2#id`): funciona de qualquer página pública, não só da home. */
export function homeSectionLinks(home: HomePath = '/') {
  const base = home === '/' ? '/' : home;
  return HOME_SECTIONS.map((section) => ({
    id: section.id,
    href: `${base}#${section.id}`,
    label: section.label,
  }));
}

export const HOME_SECTION_LINKS = homeSectionLinks('/');

/** Alvo do link "Pular para o conteúdo". */
export const MAIN_CONTENT_ID = 'conteudo';
