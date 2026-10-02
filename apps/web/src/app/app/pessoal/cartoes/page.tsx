'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Plus, CreditCard as CreditCardIcon, Star } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { CreditCardForm } from '@/components/credit-cards/CreditCardForm';
import { CardSetupForm } from '@/components/credit-cards/CardSetupForm';
import { CardLimitDetails } from '@/components/credit-cards/CardLimitCard';
import { useCreditCards, type CreditCard } from '@/hooks/useCreditCards';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm';
import { cn } from '@/lib/utils';

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

export default function CartoesPage() {
  const { data, archived, loading, refetch } = useCreditCards();
  const [formOpen, setFormOpen] = useState(false);
  const [editingCard, setEditingCard] = useState<CreditCard | undefined>();
  const [settingUp, setSettingUp] = useState<CreditCard | null>(null);
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

  /** Liga ou desliga o cartão como padrão dos novos lançamentos. */
  const togglePreferred = async (card: CreditCard) => {
    try {
      await apiClient.patch(
        '/financial-resources/preferred',
        card.isPreferred ? {} : { cardId: card.id },
      );
      toast.success(
        card.isPreferred
          ? 'Nenhuma conta ou cartão vem selecionado nos novos lançamentos.'
          : `"${card.name}" vem selecionado nos novos lançamentos.`,
      );
      void refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao definir o padrão dos lançamentos');
    }
  };

  const handleArchive = async (card: CreditCard) => {
    const ok = await confirm({
      title: 'Arquivar cartão',
      description: `"${card.name}" deixa de receber compras. O histórico continua disponível.`,
      confirmText: 'Arquivar',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/credit-cards/${card.id}`);
      toast.success('Cartão arquivado.');
      void refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao arquivar cartão');
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">Cartões</h1>
          <p className="text-sm text-muted-foreground">
            Seus cartões. Para ver e pagar as faturas, use{' '}
            <Link href="/app/pessoal/faturas" className="font-medium text-foreground underline">
              Faturas
            </Link>
            .
          </p>
        </div>
        <Button size="sm" onClick={openNew}>
          <Plus className="mr-1 h-4 w-4" />
          Novo cartão
        </Button>
      </div>

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
                          <Link
                            href={`/app/pessoal/cartoes/${card.id}`}
                            className="truncate font-medium hover:underline"
                          >
                            {card.name}
                          </Link>
                          {card.isPreferred && (
                            <Star
                              className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400"
                              aria-label="Padrão nos lançamentos"
                            />
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

                  {card.needsSetup ? (
                    <div className="space-y-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-900">
                      <p>
                        Sem fechamento configurado: os lançamentos aparecem no período, mas ainda
                        não formam faturas nem contam no limite.
                      </p>
                      <Button size="sm" className="h-8" onClick={() => setSettingUp(card)}>
                        Configurar fechamento
                      </Button>
                    </div>
                  ) : (
                    <>
                      {/* O limite, não a fatura: a fatura fica na tela Faturas (docs/adrs/0020). */}
                      <CardLimitDetails card={card} />
                      <p className="text-xs text-muted-foreground">
                        Fecha dia {card.closingDay} · vence dia {card.dueDay}
                      </p>
                    </>
                  )}

                  {!card.needsSetup && (
                    <Button asChild size="sm" variant="outline" className="h-8 w-full">
                      <Link href={`/app/pessoal/faturas?cartao=${card.id}`}>Ver faturas</Link>
                    </Button>
                  )}

                  <div className="flex items-center justify-between gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className={cn(
                        'h-7 min-w-0 px-2 text-xs',
                        card.isPreferred && 'font-medium text-amber-600',
                      )}
                      title={
                        card.isPreferred
                          ? 'Deixar de usar como padrão'
                          : 'Vir selecionado em novos lançamentos'
                      }
                      onClick={() => void togglePreferred(card)}
                    >
                      <Star
                        className={cn(
                          'mr-1 h-3.5 w-3.5 shrink-0',
                          card.isPreferred && 'fill-amber-400 text-amber-400',
                        )}
                      />
                      <span className="truncate">
                        {card.isPreferred ? 'Padrão nos lançamentos' : 'Usar como padrão'}
                      </span>
                    </Button>
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
                        onClick={() => void handleArchive(card)}
                      >
                        Arquivar
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {archived.length > 0 && (
        <details className="group rounded-2xl border bg-card">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-4 text-sm font-medium">
            <span>Arquivados ({archived.length})</span>
            <span className="text-xs text-muted-foreground group-open:hidden">Mostrar</span>
            <span className="hidden text-xs text-muted-foreground group-open:inline">Ocultar</span>
          </summary>
          <ul className="divide-y border-t">
            {archived.map((card) => (
              <li key={card.id} className="flex items-center justify-between gap-3 p-4">
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white opacity-60"
                    style={{ backgroundColor: card.color ?? '#94a3b8' }}
                  >
                    <CreditCardIcon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <Link
                      href={`/app/pessoal/cartoes/${card.id}`}
                      className="block truncate text-sm font-medium hover:underline"
                    >
                      {card.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {(card.totalDebt ?? 0) > 0
                        ? `Ainda deve ${formatCurrency(card.totalDebt ?? 0)}: continua pagável e entra nos totais.`
                        : 'Não recebe compras; o histórico continua disponível.'}
                    </p>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 px-2"
                  onClick={() => openEdit(card)}
                >
                  Editar
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <Dialog
        open={settingUp !== null}
        onClose={() => setSettingUp(null)}
        title="Configurar fechamento"
      >
        {settingUp && (
          <CardSetupForm
            card={settingUp}
            onSuccess={() => {
              setSettingUp(null);
              void refetch();
            }}
            onCancel={() => setSettingUp(null)}
          />
        )}
      </Dialog>

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
