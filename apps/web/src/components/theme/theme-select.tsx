'use client';
import { useSyncExternalStore } from 'react';
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import {
  applyPreference,
  readPreference,
  subscribeTheme,
  type ThemePreference,
} from '@/lib/public-theme';
import { cn } from '@/lib/utils';

const OPTIONS: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
  { value: 'system', label: 'Sistema', icon: Monitor },
  { value: 'light', label: 'Claro', icon: Sun },
  { value: 'dark', label: 'Escuro', icon: Moon },
];

/** No servidor não há escolha lida: nasce em "Sistema" e corrige na hidratação. */
const serverPreference = (): ThemePreference => 'system';

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribeTheme, readPreference, serverPreference);
}

/**
 * Escolha de tema em três opções: seguir o sistema (padrão), claro ou escuro.
 * `compact` mostra só um botão que alterna entre as três (menu recolhido).
 */
export function ThemeSelect({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const preference = useThemePreference();

  if (compact) {
    const index = OPTIONS.findIndex((o) => o.value === preference);
    const current = OPTIONS[index];
    const next = OPTIONS[(index + 1) % OPTIONS.length];
    return (
      <button
        type="button"
        onClick={() => applyPreference(next.value)}
        aria-label={`Tema: ${current.label}. Mudar para ${next.label.toLowerCase()}`}
        title={`Tema: ${current.label}`}
        className={cn(
          'inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
      >
        <current.icon aria-hidden className="h-4 w-4" />
      </button>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label="Tema"
      className={cn('grid grid-cols-3 gap-1 rounded-lg bg-muted p-1', className)}
    >
      {OPTIONS.map((option) => {
        const selected = option.value === preference;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => applyPreference(option.value)}
            className={cn(
              'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              selected
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <option.icon aria-hidden className="h-3.5 w-3.5" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
