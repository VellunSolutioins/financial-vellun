import { cn } from '@/lib/utils';
import { Brand } from './brand';
import { SkipLink } from './skip-link';
import { HeaderActions, SiteNav } from './site-nav';
import { container } from './styles';

/**
 * Cabeçalho fixo das páginas públicas; as âncoras levam à home de qualquer
 * página. No mobile: marca, botão principal e menu. A partir do `md`, as
 * âncoras e "Entrar" ficam visíveis e o menu some.
 *
 * Toda página que usa este cabeçalho precisa de um `<main id={MAIN_CONTENT_ID}>`
 * para o link "Pular para o conteúdo".
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b bg-background">
      <SkipLink />
      <div className={cn(container, 'flex h-16 items-center justify-between gap-2')}>
        <Brand withSlogan />
        <SiteNav />
        <HeaderActions />
      </div>
    </header>
  );
}
