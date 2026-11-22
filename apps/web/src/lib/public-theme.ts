/**
 * Tema (claro/escuro) das páginas públicas. A escolha fica no `localStorage`;
 * sem escolha, segue o sistema. O valor efetivo vive em `<html data-theme>`,
 * aplicado antes da primeira pintura por `THEME_INIT_SCRIPT`.
 */
export type PublicTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'zeloo-theme';

/** Roda no <head>, antes do React: evita a página abrir clara e escurecer. */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.dataset.theme=t}catch(e){}})();`;

export function readTheme(): PublicTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme: PublicTheme) {
  const root = document.documentElement;
  // Sem transições durante a troca: senão cada borda e fundo anima no seu tempo.
  root.setAttribute('data-theme-switching', '');
  root.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Modo privado ou armazenamento cheio: vale só nesta visita.
  }
  window.dispatchEvent(new Event('zeloo-theme-change'));
  requestAnimationFrame(() => root.removeAttribute('data-theme-switching'));
}

export function subscribeTheme(onChange: () => void) {
  window.addEventListener('zeloo-theme-change', onChange);
  return () => window.removeEventListener('zeloo-theme-change', onChange);
}
