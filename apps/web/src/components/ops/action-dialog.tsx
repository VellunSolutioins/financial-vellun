'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Mesmo mínimo que a API exige, para o erro não chegar como 400 depois do envio. */
const MINIMO_JUSTIFICATIVA = 3;

export interface ActionDialogProps {
  open: boolean;
  title: string;
  /** O que vai acontecer, em uma frase. Aparece acima do campo. */
  description: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}

/**
 * Confirmação com justificativa obrigatória.
 *
 * A justificativa é campo do formulário porque é campo da API: reprocessar e
 * descartar entram na trilha de auditoria, e uma linha sem motivo responde
 * "quem" e "o quê" sem responder "por quê" — que é a pergunta que se faz meses
 * depois, quando ninguém lembra.
 */
export function ActionDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  onClose,
  onConfirm,
}: ActionDialogProps) {
  const [reason, setReason] = useState('');
  const [enviando, setEnviando] = useState(false);

  const fechar = () => {
    if (enviando) return;
    setReason('');
    onClose();
  };

  const confirmar = async () => {
    setEnviando(true);
    try {
      await onConfirm(reason.trim());
      setReason('');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialog open={open} onClose={fechar} title={title}>
      <div className="space-y-4">
        <div className="text-sm text-muted-foreground">{description}</div>

        <div className="space-y-1.5">
          <Label htmlFor="action-reason">Justificativa</Label>
          <Input
            id="action-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Fica registrada na auditoria"
            maxLength={500}
            autoFocus
          />
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={() => void confirmar()}
            disabled={enviando || reason.trim().length < MINIMO_JUSTIFICATIVA}
          >
            {enviando ? 'Enviando…' : confirmLabel}
          </Button>
          <Button variant="outline" onClick={fechar} disabled={enviando}>
            Cancelar
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
