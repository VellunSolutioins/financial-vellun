'use client';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Peças do Início no idioma "de extrato" das páginas públicas: rótulos mono em
 * caixa baixa (`nº 01 — assunto`), títulos com destaque em serifada itálica e
 * valores com centavos menores. Tudo sai dos tokens, então vale nos dois temas.
 */

/** `nº 01 — assunto` e o título da seção, com a parte em destaque em itálico. */
export function SectionHeading({
  id,
  number,
  eyebrow,
  title,
  emphasis,
  aside,
}: {
  id: string;
  number: number;
  eyebrow: string;
  title: string;
  emphasis: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div className="min-w-0">
        <p className="font-mono text-xs lowercase tracking-wide text-muted-foreground">
          <span className="text-primary">nº {String(number).padStart(2, '0')}</span> — {eyebrow}
        </p>
        <h2 id={id} className="mt-1 text-lg font-medium tracking-tight sm:text-xl">
          {title} <em className="text-emphasis">{emphasis}</em>
        </h2>
      </div>
      {aside}
    </div>
  );
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Sobe do valor anterior (0 na primeira vez) até `target`; parado com movimento reduzido. */
function useCountUp(target: number, duration = 700) {
  const [value, setValue] = useState(() => (prefersReducedMotion() ? target : 0));
  const from = useRef(value);

  useEffect(() => {
    if (prefersReducedMotion()) {
      from.current = target;
      setValue(target);
      return;
    }
    const start = performance.now();
    const origin = from.current;
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const current = origin + (target - origin) * eased;
      from.current = current;
      setValue(current);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);

  return value;
}

const fullCurrency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * "R$ 21.750,86" com o "R$" e os centavos menores e mais claros: o olho lê
 * primeiro os reais. O valor animado é só visual; a leitura assistiva recebe
 * o valor final.
 */
export function Amount({
  value,
  animate = false,
  className,
}: {
  value: number;
  animate?: boolean;
  className?: string;
}) {
  const animated = useCountUp(value);
  const shown = animate ? animated : value;
  const [reais, cents] = Math.abs(shown).toFixed(2).split('.');
  return (
    <span className={cn('inline-flex items-baseline tabular-nums', className)}>
      <span className="sr-only">{fullCurrency.format(value)}</span>
      <span aria-hidden className="inline-flex items-baseline">
        <span className="mr-[0.2em] self-start pt-[0.18em] text-[0.42em] font-semibold text-muted-foreground">
          {shown < 0 ? '−R$' : 'R$'}
        </span>
        {Number(reais).toLocaleString('pt-BR')}
        <span className="text-[0.5em] font-semibold text-muted-foreground">,{cents}</span>
      </span>
    </span>
  );
}

/**
 * Cabeçalho das telas do app: rótulo mono em cima (`lançamentos · novembro`),
 * título com a parte em destaque em itálico na cor da marca e as ações à direita.
 */
export function PageHeading({
  eyebrow,
  title,
  emphasis,
  description,
  actions,
}: {
  eyebrow: React.ReactNode;
  title: string;
  emphasis?: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <p className="font-mono text-xs lowercase tracking-wide text-muted-foreground">{eyebrow}</p>
        <h1 className="mt-1 text-2xl font-medium tracking-tight sm:text-3xl">
          {title}
          {emphasis && (
            <>
              {' '}
              <em className="text-emphasis">{emphasis}</em>
            </>
          )}
        </h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Linha de extrato: rótulo, pontilhado e valor. */
export function LedgerRow({
  label,
  children,
  className,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-baseline gap-2', className)}>
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <span
        className="min-w-4 flex-1 translate-y-[-3px] border-b border-dotted border-muted-foreground/40"
        aria-hidden
      />
      <span className="shrink-0">{children}</span>
    </div>
  );
}
