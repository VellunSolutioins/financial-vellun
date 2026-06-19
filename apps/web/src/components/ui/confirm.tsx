'use client';
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

export interface ConfirmOptions {
  title?: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  /** `destructive` deixa o botão de confirmação em vermelho (ações irreversíveis). */
  variant?: 'default' | 'destructive';
}

type ConfirmFn = (options?: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * Hook de confirmação no estilo "swal": `const ok = await confirm({ ... })`.
 * Substitui o `window.confirm` por um modal próprio, no design system do app.
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm deve ser usado dentro de <ConfirmProvider>');
  return ctx;
}

interface ConfirmState extends ConfirmOptions {
  open: boolean;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ConfirmState>({ open: false });
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    setState({ open: true, ...options });
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = useCallback((result: boolean) => {
    resolver.current?.(result);
    resolver.current = null;
    setState((prev) => ({ ...prev, open: false }));
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={state.open} onClose={() => close(false)} title={state.title ?? 'Confirmar'}>
        {state.description && (
          <p className="mb-6 text-sm text-muted-foreground">{state.description}</p>
        )}
        {/* Mobile first: botões empilhados no mobile, lado a lado no desktop */}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => close(false)}>
            {state.cancelText ?? 'Cancelar'}
          </Button>
          <Button
            variant={state.variant === 'destructive' ? 'destructive' : 'default'}
            onClick={() => close(true)}
          >
            {state.confirmText ?? 'Confirmar'}
          </Button>
        </div>
      </Dialog>
    </ConfirmContext.Provider>
  );
}
