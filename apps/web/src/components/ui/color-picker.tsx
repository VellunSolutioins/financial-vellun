'use client';
import * as React from 'react';
import { HexColorInput, HexColorPicker } from 'react-colorful';
import { Check, ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';

/** Cor aceita pela API: `#RRGGBB`. */
export const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

/** Paleta padrão dos atalhos. */
export const DEFAULT_COLOR_PRESETS = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#84cc16',
  '#10b981',
  '#14b8a6',
  '#0ea5e9',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#64748b',
];

/** Cor inicial do seletor livre quando ainda não há cor escolhida. */
const PICKER_FALLBACK = '#3b82f6';

/** Marca de seleção escura sobre cores claras, clara sobre as escuras. */
function isLight(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6;
}

export interface ColorPickerProps {
  /** `#RRGGBB`, ou `''` para "sem cor" (quando `allowEmpty`). */
  value: string;
  onChange: (value: string) => void;
  presets?: string[];
  /** Oferece a opção "sem cor". */
  allowEmpty?: boolean;
  label?: string;
  className?: string;
}

/**
 * Atalhos de cor + seletor livre (react-colorful) com campo hex.
 *
 * O seletor livre fica recolhido atrás de um botão para o formulário continuar
 * curto em tela estreita; abre inline, sem popover, porque vive dentro de
 * diálogos que já rolam. Sempre emite `#RRGGBB` minúsculo.
 */
export function ColorPicker({
  value,
  onChange,
  presets = DEFAULT_COLOR_PRESETS,
  allowEmpty = false,
  label = 'Cor',
  className,
}: ColorPickerProps) {
  const normalized = value.toLowerCase();
  const isCustom = !!normalized && !presets.includes(normalized);
  const [open, setOpen] = React.useState(isCustom);
  const pickerId = React.useId();

  const emit = (next: string) => onChange(next.toLowerCase());

  const swatchClass =
    'flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {allowEmpty && (
          <button
            type="button"
            role="radio"
            aria-checked={!normalized}
            aria-label="Sem cor"
            title="Sem cor"
            onClick={() => onChange('')}
            className={cn(
              swatchClass,
              'relative overflow-hidden border border-border bg-background',
              !normalized && 'ring-2 ring-foreground',
            )}
          >
            <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 rotate-45 bg-muted-foreground" />
          </button>
        )}
        {presets.map((color) => {
          const selected = normalized === color;
          return (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`Cor ${color}`}
              title={color}
              onClick={() => emit(color)}
              className={cn(swatchClass, selected && 'ring-2 ring-foreground')}
              style={{ backgroundColor: color }}
            >
              {selected && (
                <Check className={cn('h-4 w-4', isLight(color) ? 'text-black' : 'text-white')} />
              )}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={pickerId}
        className="flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <span
          className={cn(
            'h-5 w-5 rounded-full border border-border',
            !isCustom &&
              'bg-[conic-gradient(#ef4444,#f59e0b,#84cc16,#14b8a6,#3b82f6,#8b5cf6,#ec4899,#ef4444)]',
          )}
          style={isCustom ? { backgroundColor: normalized } : undefined}
        />
        {isCustom ? `Cor personalizada (${normalized})` : 'Escolher outra cor'}
        <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div id={pickerId} className="space-y-3 rounded-lg border border-border p-3">
          <HexColorPicker
            color={normalized || PICKER_FALLBACK}
            onChange={emit}
            style={{ width: '100%', height: 160 }}
          />
          <div className="flex items-center gap-2">
            <span
              className="h-10 w-10 shrink-0 rounded-md border border-border"
              style={{ backgroundColor: normalized || 'transparent' }}
              aria-hidden
            />
            <HexColorInput
              color={normalized}
              // O campo também emite `#abc` no meio da digitação de `#abcdef`;
              // só o formato longo vale (é o que a API aceita).
              onChange={(next) => HEX_COLOR.test(next) && emit(next)}
              prefixed
              aria-label="Código hexadecimal da cor"
              placeholder="#000000"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm uppercase ring-offset-background placeholder:normal-case placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
          </div>
        </div>
      )}
    </div>
  );
}
