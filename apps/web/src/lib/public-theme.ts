/**
 * Tema (claro/escuro) do site inteiro. Por padrão segue o sistema; a pessoa
 * pode fixar claro ou escuro, e a escolha fica no `localStorage`. "Sistema"
 * apaga a escolha e volta a acompanhar o aparelho. O valor efetivo vive em
 * `<html data-theme>`, aplicado antes da primeira pintura por
 * `THEME_INIT_SCRIPT`.
 */
export type PublicTheme = 'light' | 'dark';
/** O que a pessoa escolheu: um tema fixo ou seguir o sistema. */
export type ThemePreference = PublicTheme | 'system';

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

const systemTheme = (): PublicTheme =>
  window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

/** A escolha salva, ou `system` quando não há (ou o armazenamento falha). */
export function readPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Aplica uma preferência: tema fixo (salvo) ou `system` (apaga a escolha e
 * volta a seguir o aparelho, inclusive nas mudanças com a página aberta).
 */
export function applyPreference(preference: ThemePreference) {
  const root = document.documentElement;
  const theme = preference === 'system' ? systemTheme() : preference;
  // Sem transições durante a troca: senão cada borda e fundo anima no seu tempo.
  root.setAttribute('data-theme-switching', '');
  root.dataset.theme = theme;
  // Força o cálculo de estilo agora, com as transições ainda desligadas. Um
  // callback de requestAnimationFrame roda antes do cálculo do quadro, então
  // sem isto o navegador nunca chegaria a ver o atributo presente.
  void window.getComputedStyle(document.body).opacity;
  try {
    if (preference === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Modo privado ou armazenamento cheio: vale só nesta visita.
  }
  window.dispatchEvent(new Event('zeloo-theme-change'));
  setTimeout(() => root.removeAttribute('data-theme-switching'), 1);
}

/** Fixa claro ou escuro (o botão de sol/lua das páginas públicas). */
export function applyTheme(theme: PublicTheme) {
  applyPreference(theme);
}

export function subscribeTheme(onChange: () => void) {
  window.addEventListener('zeloo-theme-change', onChange);
  return () => window.removeEventListener('zeloo-theme-change', onChange);
}
