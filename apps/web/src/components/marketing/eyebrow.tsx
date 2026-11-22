import { cn } from '@/lib/utils';

/**
 * Rótulo de seção no estilo de extrato: número e assunto em fonte mono, em
 * caixa baixa. Ex.: "nº 01 — como funciona".
 */
export function Eyebrow({
  number,
  children,
  className,
}: {
  number?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={cn('font-mono text-xs lowercase tracking-wide text-ink-muted', className)}>
      {number && (
        <>
          <span className="text-primary">nº {number}</span>
          <span aria-hidden> — </span>
        </>
      )}
      {children}
    </p>
  );
}
