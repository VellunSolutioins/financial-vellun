/**
 * Tema (claro/escuro) das páginas públicas. A escolha fica no `localStorage`;
 * sem escolha, segue o sistema. O valor efetivo vive em `<html data-theme>`,
 * aplicado antes da primeira pintura por `THEME_INIT_SCRIPT`.
 */
export type PublicTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'zeloo-theme';

/**
 * Roda no <head>, antes do React: evita a página abrir clara e escurecer.
 * Sem escolha salva, também acompanha o tema do sistema se ele mudar com a
 * página aberta (e avisa os componentes pelo mesmo evento do botão). A leitura
 * do `localStorage` tem try próprio (`g`): se ela falhar (dados do site
 * bloqueados), vale como "sem escolha" e o tema do sistema continua valendo.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var k='${THEME_STORAGE_KEY}',d=document.documentElement,m=window.matchMedia('(prefers-color-scheme: dark)'),g=function(){try{var s=localStorage.getItem(k);return s==='light'||s==='dark'?s:null}catch(_){return null}},t=g()||(m.matches?'dark':'light');d.dataset.theme=t;m.addEventListener('change',function(e){if(g())return;d.dataset.theme=e.matches?'dark':'light';window.dispatchEvent(new Event('zeloo-theme-change'))})}catch(e){}})();`;

export function readTheme(): PublicTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme: PublicTheme) {
  const root = document.documentElement;
  // Sem transições durante a troca: senão cada borda e fundo anima no seu tempo.
  root.setAttribute('data-theme-switching', '');
  root.dataset.theme = theme;
  // Força o cálculo de estilo agora, com as transições ainda desligadas. Um
  // callback de requestAnimationFrame roda antes do cálculo do quadro, então
  // sem isto o navegador nunca chegaria a ver o atributo presente.
  void window.getComputedStyle(document.body).opacity;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Modo privado ou armazenamento cheio: vale só nesta visita.
  }
  window.dispatchEvent(new Event('zeloo-theme-change'));
  setTimeout(() => root.removeAttribute('data-theme-switching'), 1);
}

export function subscribeTheme(onChange: () => void) {
  window.addEventListener('zeloo-theme-change', onChange);
  return () => window.removeEventListener('zeloo-theme-change', onChange);
}
