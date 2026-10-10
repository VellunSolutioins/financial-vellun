import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface StepIndicatorProps {
  steps: readonly string[];
  /** Índice (base zero) da etapa atual. */
  current: number;
}

export function StepIndicator({ steps, current }: StepIndicatorProps) {
  return (
    <div>
      <p className="text-sm font-medium text-primary">
        Etapa {current + 1} de {steps.length}
      </p>
      <ol className="mt-3 flex gap-3">
        {steps.map((label, index) => {
          const done = index < current;
          const active = index === current;
          return (
            <li key={label} aria-current={active ? 'step' : undefined} className="min-w-0 flex-1">
              <span
                aria-hidden
                className={cn(
                  'block h-1.5 rounded-full',
                  done || active ? 'bg-primary' : 'bg-border',
                )}
              />
              <span
                className={cn(
                  'mt-2 flex items-center gap-1.5 text-sm',
                  active ? 'font-semibold text-ink' : 'text-ink-muted',
                )}
              >
                {done && <Check aria-hidden className="h-4 w-4 shrink-0 text-success" />}
                {label}
                {done && <span className="sr-only"> (concluída)</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
