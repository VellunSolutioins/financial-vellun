'use client';
import { useState } from 'react';
import { CreditCard as CreditCardIcon, Plus, Wallet } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Pagination } from '@/components/ui/pagination';
import { AdvanceInstallmentDialog } from '@/components/transactions/AdvanceInstallmentDialog';
import { DeleteInstallmentDialog } from '@/components/transactions/DeleteInstallmentDialog';
import { InstallmentForm } from '@/components/transactions/InstallmentForm';
import { InstallmentsSummary } from '@/components/transactions/InstallmentsSummary';
import { RefundForm } from '@/components/transactions/RefundForm';
import { TransactionForm } from '@/components/transactions/TransactionForm';
import { useInstallments, type Installment } from '@/hooks/useInstallments';
import { cn, formatDateBR } from '@/lib/utils';

const PAGE_SIZE = 10;

type StatusFilter = 'active' | 'closed' | 'all';

const filterLabels: Record<StatusFilter, string> = {
  active: 'Em andamento',
  closed: 'Encerrados',
  all: 'Todos',
};

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

function statusLabel(i: Installment) {
  if (i.status === 'cancelled') return 'Cancelado';
  if (i.status === 'finished') {
    // Parcelas futuras excluídas: a compra terminou antes do previsto.
    return i.parcelCount < i.installmentTotal ? 'Encerrado antes' : 'Quitado';
  }
  return 'Em andamento';
}

function AccountLabel({ i }: { i: Installment }) {
  if (!i.account) return <>—</>;
  const Icon = i.account.type === 'credit_card' ? CreditCardIcon : Wallet;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate" title={i.account.name}>
        {i.account.name}
      </span>
    </span>
  );
}

/** Em que parcela a compra está, no mesmo critério da tela de Lançamentos e do adiantamento. */
function progressText(i: Installment) {
  if (i.status === 'cancelled') return `${i.installmentTotal} parcelas`;
  const advanced =
    i.advancedCount > 0 ? ` · ${i.advancedCount} adiantada${i.advancedCount === 1 ? '' : 's'}` : '';
  if (i.currentNumber === 0) {
    return i.upcomingDate ? `1ª parcela em ${formatDateBR(i.upcomingDate)}` : '';
  }
  const current = `Parcela ${i.currentNumber}/${i.installmentTotal}`;
  const next = i.upcomingDate
    ? ` · próxima ${formatDateBR(i.upcomingDate)}`
    : i.status === 'active'
      ? ' · última'
      : '';
  return current + next + advanced;
}

/**
 * Barra até a parcela do mês atual (no cartão, a da fatura aberta), somando as
 * adiantadas — que também já estão no mês atual.
 */
function Progress({ i }: { i: Installment }) {
  const done =
    i.status === 'cancelled' ? 0 : Math.min(i.installmentTotal, i.currentNumber + i.advancedCount);
  const pct = Math.round((done / i.installmentTotal) * 100);
  return (
    <div className="space-y-1">
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={i.installmentTotal}
        aria-valuenow={done}
        aria-label={`${done} de ${i.installmentTotal} parcelas`}
      >
        <div
          className={cn(
            'h-full rounded-full',
            i.status === 'cancelled' ? 'bg-muted-foreground/40' : 'bg-primary',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">{progressText(i)}</p>
    </div>
  );
}

/**
 * Parcelamentos = séries de lançamentos parcelados. "Novo parcelamento" cria
 * um lançamento parcelado, o mesmo registro da tela de Lançamentos; aqui só
 * muda a exibição (uma linha por compra em vez de uma por parcela).
 */
export function InstallmentsView() {
  const { data, loading, error, refetch } = useInstallments();
  const [filter, setFilter] = useState<StatusFilter>('active');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Installment | undefined>();
  const [deleting, setDeleting] = useState<Installment | undefined>();
  const [refunding, setRefunding] = useState<Installment | undefined>();
  const [advancing, setAdvancing] = useState<Installment | undefined>();
  // Incrementa a cada escrita para o resumo recarregar junto com a lista.
  const [version, setVersion] = useState(0);

  const filtered = data.filter((i) =>
    filter === 'all' ? true : filter === 'active' ? i.status === 'active' : i.status !== 'active',
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageItems = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const afterWrite = () => {
    setCreating(false);
    setEditing(undefined);
    setDeleting(undefined);
    setRefunding(undefined);
    setAdvancing(undefined);
    void refetch();
    setVersion((v) => v + 1);
  };

  const statusBadge = (i: Installment) => (
    <Badge
      className={cn(
        'shrink-0',
        i.status === 'active'
          ? 'bg-blue-100 text-blue-700'
          : i.status === 'finished'
            ? 'bg-emerald-100 text-emerald-700'
            : 'bg-muted text-muted-foreground',
      )}
    >
      {statusLabel(i)}
    </Badge>
  );

  const actions = (i: Installment) => (
    <>
      <Button size="sm" variant="ghost" onClick={() => setEditing(i)}>
        Editar
      </Button>
      {i.advanceable.length > 0 && (
        <Button size="sm" variant="ghost" onClick={() => setAdvancing(i)}>
          Adiantar
        </Button>
      )}
      {i.refundAnchorId && (
        <Button size="sm" variant="ghost" onClick={() => setRefunding(i)}>
          Estornar
        </Button>
      )}
      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeleting(i)}>
        Excluir
      </Button>
    </>
  );

  const amounts = (i: Installment) => (
    <>
      <span className="font-semibold">{formatCurrency(i.totalAmount)}</span>
      <span className="block text-xs text-muted-foreground">
        {i.installmentTotal}x de {formatCurrency(i.installmentAmount)}
      </span>
    </>
  );

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">Parcelamentos</h1>
          <p className="text-sm text-muted-foreground">Compras parceladas e suas parcelas.</p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="mr-1 h-4 w-4" />
          Novo parcelamento
        </Button>
      </div>

      <InstallmentsSummary version={version} />

      <div
        role="tablist"
        aria-label="Filtrar parcelamentos"
        className="inline-flex rounded-lg border border-border bg-muted/40 p-1"
      >
        {(Object.keys(filterLabels) as StatusFilter[]).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={filter === key}
            onClick={() => {
              setFilter(key);
              setPage(1);
            }}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm transition-colors',
              filter === key
                ? 'bg-background font-medium text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {filterLabels[key]}
          </button>
        ))}
      </div>

      <Card className="rounded-2xl">
        <CardContent className="p-0">
          {error ? (
            <div role="alert" className="p-6 text-sm text-destructive">
              {error}
            </div>
          ) : loading ? (
            <div className="p-10 text-center text-sm text-muted-foreground">Carregando...</div>
          ) : filtered.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              {data.length === 0
                ? 'Nenhuma compra parcelada ainda.'
                : `Nenhum parcelamento ${filter === 'active' ? 'em andamento' : 'encerrado'}.`}
            </div>
          ) : (
            <>
              {/* Mobile: um card por compra */}
              <ul className="divide-y divide-border md:hidden">
                {pageItems.map((i) => (
                  <li key={i.seriesId} className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{i.description}</p>
                        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                          <AccountLabel i={i} />
                          {i.category && <span className="truncate">· {i.category.name}</span>}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">{amounts(i)}</div>
                    </div>
                    <Progress i={i} />
                    <div>{statusBadge(i)}</div>
                    {/* Ações numa linha própria: ao lado do status não cabem em tela estreita. */}
                    <div className="-ml-3 flex flex-wrap">{actions(i)}</div>
                  </li>
                ))}
              </ul>

              {/* Tablet/desktop: tabela */}
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                      <th className="p-3">Descrição</th>
                      <th className="p-3">Conta/Cartão</th>
                      <th className="w-48 p-3">Parcelas</th>
                      <th className="p-3 text-right">Valor</th>
                      <th className="p-3">Status</th>
                      <th className="p-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {pageItems.map((i) => (
                      <tr key={i.seriesId} className="hover:bg-muted/40">
                        <td className="p-3">
                          <p className="font-medium">{i.description}</p>
                          <p className="text-xs text-muted-foreground">
                            {i.category?.name ?? 'Sem categoria'} · desde{' '}
                            {formatDateBR(i.firstDate)}
                          </p>
                        </td>
                        <td className="max-w-[12rem] p-3 text-muted-foreground">
                          <AccountLabel i={i} />
                        </td>
                        <td className="p-3">
                          <Progress i={i} />
                        </td>
                        <td className="whitespace-nowrap p-3 text-right">{amounts(i)}</td>
                        <td className="whitespace-nowrap p-3">{statusBadge(i)}</td>
                        <td className="whitespace-nowrap p-3 text-right">{actions(i)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {filtered.length > 0 && (
        <Pagination
          page={currentPage}
          totalPages={totalPages}
          onPageChange={setPage}
          summary={`${filtered.length} parcelamento${filtered.length === 1 ? '' : 's'}`}
        />
      )}

      <Dialog open={creating} onClose={() => setCreating(false)} title="Novo parcelamento">
        {creating && (
          <TransactionForm
            installmentOnly
            onSuccess={afterWrite}
            onCancel={() => setCreating(false)}
          />
        )}
      </Dialog>

      <Dialog open={!!editing} onClose={() => setEditing(undefined)} title="Editar parcelamento">
        {editing && (
          <InstallmentForm
            installment={editing}
            onSuccess={afterWrite}
            onCancel={() => setEditing(undefined)}
          />
        )}
      </Dialog>

      <Dialog open={!!refunding} onClose={() => setRefunding(undefined)} title="Estornar compra">
        {refunding?.refundAnchorId && (
          <RefundForm
            transaction={{
              id: refunding.refundAnchorId,
              description: refunding.description,
              amount: refunding.installmentAmount,
              recurrenceType: 'parcelado',
              installmentTotal: refunding.installmentTotal,
            }}
            defaultScope="series"
            onSuccess={afterWrite}
            onCancel={() => setRefunding(undefined)}
          />
        )}
      </Dialog>

      <AdvanceInstallmentDialog
        installment={advancing}
        open={!!advancing}
        onClose={() => setAdvancing(undefined)}
        onAdvanced={afterWrite}
      />

      <DeleteInstallmentDialog
        installment={deleting}
        open={!!deleting}
        onClose={() => setDeleting(undefined)}
        onDeleted={afterWrite}
      />
    </div>
  );
}
