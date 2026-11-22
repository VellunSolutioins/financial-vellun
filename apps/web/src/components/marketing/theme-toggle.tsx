'use client';
import { useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';
import { applyTheme, readTheme, subscribeTheme, type PublicTheme } from '@/lib/public-theme';
import { cn } from '@/lib/utils';
import { focusRing } from './styles';

/** No servidor não há tema escolhido: o botão nasce como "claro" e corrige na hidratação. */
const serverTheme = (): PublicTheme => 'light';

export function usePublicTheme(): PublicTheme {
  return useSyncExternalStore(subscribeTheme, readTheme, serverTheme);
}

/** Alterna entre claro e escuro. O rótulo diz o que o clique faz. */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = usePublicTheme();
  const dark = theme === 'dark';

  return (
    <button
      type="button"
      onClick={() => applyTheme(dark ? 'light' : 'dark')}
      aria-label={dark ? 'Usar tema claro' : 'Usar tema escuro'}
      title={dark ? 'Tema claro' : 'Tema escuro'}
      className={cn(
        'inline-flex h-11 w-11 items-center justify-center rounded-lg text-ink-muted hover:bg-surface hover:text-ink',
        focusRing,
        className,
      )}
    >
      {dark ? <Sun aria-hidden className="h-5 w-5" /> : <Moon aria-hidden className="h-5 w-5" />}
    </button>
  );
}
