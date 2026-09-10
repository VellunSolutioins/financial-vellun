'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { formatAge, formatDateTime } from '@/components/ops/ops-format';
import { FailureStatusBadge } from '@/components/ops/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { DataTable, type DataTableColumn } from '@/components/ui/table';
import { useOpsList } from '@/hooks/use-ops-list';
import { failureSourceLabels, failureStatusLabels, type FailureListItem } from '@/lib/ops-types';

/** Campos do filtro que vivem na URL, para o link poder ser compartilhado. */
const CAMPOS = ['status', 'source', 'errorType', 'correlationId', 'from', 'to'] as const;
type Campo = (typeof CAMPOS)[number];
type Filtros = Record<Campo, string>;

const VAZIO: Filtros = {
  status: '',
  source: '',
  errorType: '',
  correlationId: '',
  from: '',
  to: '',
};

function FalhasContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const naUrl: Filtros = { ...VAZIO };
  for (const campo of CAMPOS) naUrl[campo] = searchParams.get(campo) ?? '';

  // Rascunho local: os filtros só vão para a URL quando o operador confirma. Um
  // `router.push` por tecla digitada empilharia histórico e refaria a busca a
  // cada caractere.
  const [rascunho, setRascunho] = useState<Filtros>(naUrl);
  const page = Number(searchParams.get('page') ?? 1);

  const { data, loading, error, totalPages } = useOpsList<FailureListItem>('/ops/failures', {
    ...naUrl,
    page,
  });

  const aplicar = (filtros: Filtros, novaPagina = 1) => {
    const params = new URLSearchParams();
    for (const campo of CAMPOS) {
      if (filtros[campo]) params.set(campo, filtros[campo]);
    }
    if (novaPagina > 1) params.set('page', String(novaPagina));
    router.push(params.toString() ? `/ops/falhas?${params.toString()}` : '/ops/falhas');
  };

  const limpar = () => {
    setRascunho(VAZIO);
    aplicar(VAZIO);
  };

  const definir = (campo: Campo, valor: string) =>
    setRascunho((atual) => ({ ...atual, [campo]: valor }));

  const columns: DataTableColumn<FailureListItem>[] = [
    {
      key: 'capturedAt',
      header: 'Capturada',
      cellClassName: 'whitespace-nowrap',
      cell: (falha) => (
        <div>
          <p>{formatDateTime(falha.capturedAt)}</p>
          <p className="text-xs text-muted-foreground">{formatAge(falha.capturedAt)}</p>
        </div>
      ),
    },
    {
      key: 'source',
      header: 'Origem',
      cell: (falha) => (
        <div className="min-w-0">
          <Badge variant="outline">{failureSourceLabels[falha.source]}</Badge>
          <p className="mt-1 truncate text-xs text-muted-foreground">{falha.sourceQueue}</p>
        </div>
      ),
    },
    {
      key: 'error',
      header: 'Erro',
      cell: (falha) => (
        <div className="max-w-xs">
          <p className="truncate font-medium">{falha.errorType}</p>
          <p className="truncate text-xs text-muted-foreground">{falha.errorMessage}</p>
        </div>
      ),
    },
    {
      key: 'attempts',
      header: 'Tentativas',
      align: 'right',
      cellClassName: 'tabular-nums whitespace-nowrap',
      cell: (falha) => (
        <>
          {falha.attempts}
          {/* `permanent` distingue "não adianta tentar de novo" de "esgotou as tentativas". */}
          {falha.permanent && <span title="Falha permanente"> · def.</span>}
        </>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (falha) => <FailureStatusBadge status={falha.status} />,
    },
    {
      key: 'acoes',
      align: 'right',
      cellClassName: 'whitespace-nowrap',
      cell: (falha) => (
        <Button asChild size="sm" variant="ghost">
          <Link href={`/ops/falhas/${falha.id}`}>Detalhes</Link>
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Falhas</h1>
        <p className="text-sm text-muted-foreground">
          Catálogo em Postgres alimentado pelas DLQs. Filtrar e paginar aqui não consome fila.
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
              {Object.entries(failureStatusLabels).map(([valor, rotulo]) => (
                <option key={valor} value={valor}>
                  {rotulo}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="source">Origem</Label>
            <Select
              id="source"
              value={rascunho.source}
              onChange={(event) => definir('source', event.target.value)}
            >
              <option value="">Todas</option>
              {Object.entries(failureSourceLabels).map(([valor, rotulo]) => (
                <option key={valor} value={valor}>
                  {rotulo}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="errorType">Tipo de erro</Label>
            <Input
              id="errorType"
              value={rascunho.errorType}
              onChange={(event) => definir('errorType', event.target.value)}
              placeholder="ConnectionError"
              maxLength={200}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="correlationId">Correlação</Label>
            <Input
              id="correlationId"
              value={rascunho.correlationId}
              onChange={(event) => definir('correlationId', event.target.value)}
              placeholder="a ponte para o log"
              maxLength={128}
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
        rowKey={(falha) => falha.id}
        loading={loading}
        minWidth={860}
        empty="Nenhuma falha com esses filtros."
      />

      {data && (
        <Pagination
          page={data.page}
          totalPages={totalPages}
          onPageChange={(nova) => aplicar(naUrl, nova)}
          summary={`${data.total} falha${data.total === 1 ? '' : 's'}`}
          disabled={loading}
        />
      )}
    </div>
  );
}

export default function OpsFalhasPage() {
  return (
    <Suspense>
      <FalhasContent />
    </Suspense>
  );
}
