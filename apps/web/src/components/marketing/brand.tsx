import Link from 'next/link';
import { cn } from '@/lib/utils';
import { focusRing } from './styles';

/** Marca das páginas públicas, sempre com link para a home. */
export function Brand({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      className={cn(
        'inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg text-base font-bold tracking-tight text-ink sm:text-lg',
        focusRing,
        className,
      )}
    >
      <span
        aria-hidden
        className="hidden h-8 w-8 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground sm:flex"
      >
        FV
      </span>
      Financial Vellun
    </Link>
  );
}
