import Link from 'next/link';
import { ZELOO_SLOGAN, ZelooLogo } from '@/components/brand/zeloo-logo';
import { cn } from '@/lib/utils';
import { focusRing } from './styles';

/** Marca das páginas públicas, sempre com link para a home. */
export function Brand({
  className,
  withSlogan = false,
}: {
  className?: string;
  /** Slogan em uma linha pequena abaixo do logo. */
  withSlogan?: boolean;
}) {
  return (
    <Link
      href="/"
      aria-label="Zeloo — página inicial"
      className={cn(
        'inline-flex min-h-11 shrink-0 flex-col items-start justify-center rounded-lg',
        focusRing,
        className,
      )}
    >
      <ZelooLogo alt="" priority className="h-7 sm:h-8" />
      {/* Abaixo de 360px não cabe ao lado de "Criar conta" e do menu. */}
      {withSlogan && (
        <span className="mt-1 hidden whitespace-nowrap text-[11px] leading-none text-ink-muted min-[360px]:block sm:text-xs">
          {ZELOO_SLOGAN}
        </span>
      )}
    </Link>
  );
}
