import { CircleAlert } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * Controles das páginas de autenticação: 48 px de altura e texto de 16 px (o
 * iOS dá zoom ao focar campos com fonte menor). O erro muda a borda, além do
 * texto com ícone abaixo do campo.
 */
export const fieldControlClass =
  'h-12 rounded-xl px-3.5 text-base aria-[invalid=true]:border-danger aria-[invalid=true]:focus-visible:ring-danger';

/** Atributos que ligam o controle ao label, à dica e ao erro. */
export interface FieldControlProps {
  id: string;
  'aria-invalid': boolean;
  'aria-describedby': string | undefined;
}

interface FormFieldProps {
  id: string;
  label: string;
  optional?: boolean;
  hint?: string;
  error?: string;
  className?: string;
  children: (control: FieldControlProps) => React.ReactNode;
}

/** Label visível + controle + dica + erro, com a acessibilidade já amarrada. */
export function FormField({
  id,
  label,
  optional,
  hint,
  error,
  className,
  children,
}: FormFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('space-y-2', className)}>
      <Label htmlFor={id} className="text-ink">
        {label}
        {optional && <span className="font-normal text-ink-muted"> (opcional)</span>}
      </Label>
      {children({ id, 'aria-invalid': !!error, 'aria-describedby': describedBy })}
      {hint && (
        <p id={hintId} className="text-sm text-ink-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="flex items-start gap-1.5 text-sm text-danger">
          <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}
