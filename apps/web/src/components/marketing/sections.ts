/** Seções da home com âncora. Cabeçalho, menu e rodapé usam esta mesma lista. */
export const HOME_SECTIONS = [
  { id: 'como-funciona', label: 'Como funciona' },
  { id: 'recursos', label: 'Recursos' },
  { id: 'duvidas', label: 'Dúvidas' },
] as const;

export type HomeSectionId = (typeof HOME_SECTIONS)[number]['id'];

/** `/#id`: funciona de qualquer página pública, não só da home. */
export const HOME_SECTION_LINKS = HOME_SECTIONS.map((section) => ({
  id: section.id,
  href: `/#${section.id}`,
  label: section.label,
}));

/** Alvo do link "Pular para o conteúdo". */
export const MAIN_CONTENT_ID = 'conteudo';
