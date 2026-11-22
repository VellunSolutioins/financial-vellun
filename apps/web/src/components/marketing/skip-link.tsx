import { cn } from '@/lib/utils';
import { MAIN_CONTENT_ID } from './sections';
import { focusRing } from './styles';

/**
 * Primeiro item focável da página: quem navega por teclado pula o cabeçalho.
 * Fica invisível até receber foco.
 */
export function SkipLink() {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      className={cn(
        'sr-only rounded-lg bg-background px-4 py-3 text-sm font-semibold text-ink shadow-card',
        'focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-50',
        focusRing,
      )}
    >
      Pular para o conteúdo
    </a>
  );
}
