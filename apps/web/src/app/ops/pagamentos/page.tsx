'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { formatAge, formatDateTime } from '@/components/ops/ops-format';
import { PaymentStatusBadge } from '@/components/ops/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { DataTable, type DataTableColumn } from '@/components/ui/table';
import { useOpsList } from '@/hooks/use-ops-list';
import { paymentStatusLabels, type PaymentEventListItem } from '@/lib/ops-types';

const CAMPOS = ['status', 'eventType', 'providerEventId', 'from', 'to'] as const;
type Campo = (typeof CAMPOS)[number];
type Filtros = Record<Campo, string>;

const VAZIO: Filtros = { status: '', eventType: '', providerEventId: '', from: '', to: '' };

function PagamentosContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const naUrl: Filtros = { ...VAZIO };
  for (const campo of CAMPOS) naUrl[campo] = searchParams.get(campo) ?? '';

  const [rascunho, setRascunho] = useState<Filtros>(naUrl);
  const page = Number(searchParams.get('page') ?? 1);

  const { data, loading, error, totalPages } = useOpsList<PaymentEventListItem>('/ops/payments', {
    ...naUrl,
    page,
  });

  const aplicar = (filtros: Filtros, novaPagina = 1) => {
    const params = new URLSearchParams();
    for (const campo of CAMPOS) {
      if (filtros[campo]) params.set(campo, filtros[campo]);
    }
    if (novaPagina > 1) params.set('page', String(novaPagina));
    router.push(params.toString() ? `/ops/pagamentos?${params.toString()}` : '/ops/pagamentos');
  };

  const limpar = () => {
    setRascunho(VAZIO);
    aplicar(VAZIO);
  };

  const definir = (campo: Campo, valor: string) =>
    setRascunho((atual) => ({ ...atual, [campo]: valor }));

  const columns: DataTableColumn<PaymentEventListItem>[] = [
    {
      key: 'receivedAt',
      header: 'Recebido',
      cellClassName: 'whitespace-nowrap',
      cell: (evento) => (
        <div>
          <p>{formatDateTime(evento.receivedAt)}</p>
          <p className="text-xs text-muted-foreground">{formatAge(evento.receivedAt)}</p>
        </div>
      ),
    },
    {
      key: 'eventType',
      header: 'Evento',
      cell: (evento) => (
        <div className="max-w-xs">
          <p className="truncate font-medium">{evento.eventType}</p>
          <p className="truncate text-xs text-muted-foreground">{evento.providerEventId}</p>
        </div>
      ),
    },
    {
      key: 'lastError',
      header: 'Último erro',
      cell: (evento) => (
        <p className="max-w-xs truncate text-xs text-muted-foreground">{evento.lastError ?? '—'}</p>
      ),
    },
    {
      key: 'attempts',
      header: 'Tentativas',
      align: 'right',
      cellClassName: 'tabular-nums whitespace-nowrap',
      cell: (evento) => (
        <div>
          <p>{evento.attempts}</p>
          {/* Só quando há retry agendado: é o que separa "vai se resolver" de
              "parou e espera alguém". */}
          {evento.nextRetryAt && (
            <p className="text-xs font-normal text-muted-foreground">
              {formatDateTime(evento.nextRetryAt)}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (evento) => <PaymentStatusBadge status={evento.status} />,
    },
    {
      key: 'acoes',
      align: 'right',
      cellClassName: 'whitespace-nowrap',
      cell: (evento) => (
        <Button asChild size="sm" variant="ghost">
          <Link href={`/ops/pagamentos/${evento.id}`}>Detalhes</Link>
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Webhooks de pagamento</h1>
        <p className="text-sm text-muted-foreground">
          Eventos do PSP como foram recebidos, antes de processar. &ldquo;Vai retentar&rdquo; tem
          data marcada e caminha sozinho; &ldquo;esgotado&rdquo; parou e espera um operador.
        </p>
      </div>

      <form
        className="space-y-3 rounded-lg border bg-card p-4"
        onSubmit={(event) => {
          event.preventDefault();
          aplicar(rascunho);
        }}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="status">Status</Label>
            <Select
              id="status"
              value={rascunho.status}
              onChange={(event) => definir('status', event.target.value)}
            >
              <option value="">Todos</option>
              {Object.entries(paymentStatusLabels).map(([valor, rotulo]) => (
                <option key={valor} value={valor}>
                  {rotulo}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="eventType">Tipo do evento</Label>
            <Input
              id="eventType"
              value={rascunho.eventType}
              onChange={(event) => definir('eventType', event.target.value)}
              placeholder="PAYMENT_RECEIVED"
              maxLength={200}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="providerEventId">Id no provedor</Label>
            <Input
              id="providerEventId"
              value={rascunho.providerEventId}
              onChange={(event) => definir('providerEventId', event.target.value)}
              placeholder="evt_..."
              maxLength={200}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="from">De</Label>
            <Input
              id="from"
              type="date"
              value={rascunho.from.slice(0, 10)}
              onChange={(event) =>
                definir('from', event.target.value ? `${event.target.value}T00:00:00.000Z` : '')
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="to">Até</Label>
            <Input
              id="to"
              type="date"
              value={rascunho.to.slice(0, 10)}
              onChange={(event) =>
                definir('to', event.target.value ? `${event.target.value}T23:59:59.999Z` : '')
              }
            />
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" size="sm">
            Filtrar
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={limpar}>
            Limpar
          </Button>
        </div>
      </form>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        >
          {error}
        </p>
      )}

      <DataTable
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(evento) => evento.id}
        loading={loading}
        minWidth={860}
        empty="Nenhum evento com esses filtros."
      />

      {data && (
        <Pagination
          page={data.page}
          totalPages={totalPages}
          onPageChange={(nova) => aplicar(naUrl, nova)}
          summary={`${data.total} evento${data.total === 1 ? '' : 's'}`}
          disabled={loading}
        />
      )}
    </div>
  );
}

export default function OpsPagamentosPage() {
  return (
    <Suspense>
      <PagamentosContent />
    </Suspense>
  );
}
