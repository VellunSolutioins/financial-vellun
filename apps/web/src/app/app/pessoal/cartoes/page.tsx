'use client';
import { useState } from 'react';
import { Plus, CreditCard as CreditCardIcon, Star } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { CreditCardForm } from '@/components/credit-cards/CreditCardForm';
import { useCreditCards, type CreditCard } from '@/hooks/useCreditCards';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm';
import { cn } from '@/lib/utils';

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

/** Cores da barra por faixa de comprometimento do limite (ver credit-cards.service.ts). */
const healthBarStyles: Record<string, string> = {
  tranquilo: 'bg-emerald-500',
  saudavel: 'bg-blue-500',
  atencao: 'bg-amber-500',
  apertado: 'bg-orange-500',
  no_limite: 'bg-rose-500',
  limite_atingido: 'bg-rose-600',
};

export default function CartoesPage() {
  const { data, summary, loading, refetch } = useCreditCards();
  const [formOpen, setFormOpen] = useState(false);
  const [editingCard, setEditingCard] = useState<CreditCard | undefined>();
  const toast = useToast();
  const confirm = useConfirm();

  const openNew = () => {
    setEditingCard(undefined);
    setFormOpen(true);
  };
  const openEdit = (card: CreditCard) => {
    setEditingCard(card);
    setFormOpen(true);
  };
  const closeForm = () => setFormOpen(false);
  const handleFormSuccess = () => {
    closeForm();
    void refetch();
  };

  const handleSetPrimary = async (card: CreditCard) => {
    try {
      await apiClient.patch(`/credit-cards/${card.id}/primary`, {});
      toast.success(`"${card.name}" agora é o cartão principal.`);
      void refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao definir cartão principal');
    }
  };

  const handleDelete = async (card: CreditCard) => {
    const ok = await confirm({
      title: 'Excluir cartão',
      description: `Excluir "${card.name}"?`,
      confirmText: 'Excluir',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/credit-cards/${card.id}`);
      toast.success('Cartão excluído.');
      void refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao excluir cartão');
    }
  };

  const summaryBarWidth =
    summary && summary.totalLimit > 0
      ? Math.max(0, Math.min(100, (summary.totalCommitted / summary.totalLimit) * 100))
      : 0;

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">Cartões</h1>
          <p className="text-sm text-muted-foreground">Faturas e limites dos seus cartões.</p>
        </div>
        <Button size="sm" onClick={openNew}>
          <Plus className="mr-1 h-4 w-4" />
          Novo cartão
        </Button>
      </div>

      {summary && summary.cardCount > 0 && (
        <Card className="rounded-2xl">
          <CardContent className="space-y-3 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">
                Comprometido em todos os cartões
              </span>
              {summary.incomeHealth && (
                <Badge className="shrink-0 bg-muted text-foreground">
                  {summary.incomeHealth.emoji} {summary.incomeHealth.label}
                </Badge>
              )}
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold">{formatCurrency(summary.totalCommitted)}</span>
              {summary.totalLimit > 0 && (
                <span className="text-sm text-muted-foreground">
                  / {formatCurrency(summary.totalLimit)}
                </span>
              )}
            </div>
            {summary.totalLimit > 0 && (
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${summaryBarWidth}%` }}
                />
              </div>
            )}
            {summary.incomePercentage !== null && (
              <p className="text-xs text-muted-foreground">
                {summary.incomePercentage.toFixed(0)}% da renda fixa mensal comprometida com
                faturas.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="p-10 text-center text-sm text-muted-foreground">Carregando...</div>
      ) : data.length === 0 ? (
        <Card className="rounded-2xl">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Nenhum cartão cadastrado ainda.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((card) => {
            const barWidth =
              card.percentage !== null ? Math.max(0, Math.min(100, card.percentage)) : 0;
            return (
              <Card key={card.id} className="rounded-2xl">
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white"
                        style={{ backgroundColor: card.color ?? '#94a3b8' }}
                      >
                        <CreditCardIcon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="truncate font-medium">{card.name}</p>
                          {card.isPrimary && (
                            <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" />
                          )}
                        </div>
                        {card.brand && (
                          <p className="text-xs text-muted-foreground">{card.brand}</p>
                        )}
                      </div>
                    </div>
                    {card.health && (
                      <Badge className="shrink-0 bg-muted text-foreground">
                        {card.health.emoji} {card.health.label}
                      </Badge>
                    )}
                  </div>

                  <div>
                    <p className="text-xs text-muted-foreground">Fatura atual</p>
                    <span className="text-xl font-bold">{formatCurrency(card.currentInvoice)}</span>
                  </div>

                  {card.creditLimit !== null && (
                    <>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn(
                            'h-full rounded-full transition-all',
                            card.health ? healthBarStyles[card.health.key] : 'bg-primary',
                          )}
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                      {card.health && (
                        <p className="text-xs italic text-muted-foreground">
                          {card.health.message}
                        </p>
                      )}
                    </>
                  )}

                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    {card.available !== null ? (
                      <span>
                        Disponível{' '}
                        <span className="font-semibold text-foreground">
                          {formatCurrency(card.available)}
                        </span>
                      </span>
                    ) : (
                      <span>Sem limite definido</span>
                    )}
                    <span>Vence dia {card.dueDay}</span>
                  </div>

                  <div className="flex items-center justify-between gap-1">
                    {!card.isPrimary ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        onClick={() => void handleSetPrimary(card)}
                      >
                        Tornar principal
                      </Button>
                    ) : (
                      <span className="text-xs font-medium text-amber-600">Cartão principal</span>
                    )}
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2"
                        onClick={() => openEdit(card)}
                      >
                        Editar
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-destructive"
                        onClick={() => void handleDelete(card)}
                      >
                        Excluir
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog
        open={formOpen}
        onClose={closeForm}
        title={editingCard ? 'Editar cartão' : 'Novo cartão'}
      >
        <CreditCardForm card={editingCard} onSuccess={handleFormSuccess} onCancel={closeForm} />
      </Dialog>
    </div>
  );
}
