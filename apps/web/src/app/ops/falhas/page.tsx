'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { ActionDialog } from '@/components/ops/action-dialog';
import { formatAge, formatDateTime } from '@/components/ops/ops-format';
import { FailureStatusBadge } from '@/components/ops/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { DataTable, type DataTableColumn } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useOpsSession } from '@/contexts/ops-session-context';
import { useOpsList } from '@/hooks/use-ops-list';
import { OpsApiError, opsApiClient } from '@/lib/ops-api-client';
import {
  failureSourceLabels,
  failureStatusLabels,
  reprocessOutcomeLabels,
  type FailureListItem,
  type ReprocessBatchResult,
} from '@/lib/ops-types';

/** Mesmo teto da API: o lote precisa caber numa decisao humana. */
const MAX_LOTE = 50;

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

  const { data, loading, error, totalPages, reload } = useOpsList<FailureListItem>(
    '/ops/failures',
    { ...naUrl, page },
  );

  const toast = useToast();
  const { hasRole } = useOpsSession();
  const podeReprocessar = hasRole('operator', 'ops_admin');

  const [selecionadas, setSelecionadas] = useState<string[]>([]);
  const [loteAberto, setLoteAberto] = useState(false);
  const [resultado, setResultado] = useState<ReprocessBatchResult | null>(null);

  // Só o que está pendente entra no lote: a API pularia o resto, e oferecer uma
  // caixa que não faz nada é pior do que não oferecer.
  const elegiveis = (data?.items ?? []).filter((falha) => falha.status === 'pending');
  const selecionaveis = elegiveis.slice(0, MAX_LOTE).map((falha) => falha.id);
  const todasMarcadas =
    selecionaveis.length > 0 && selecionaveis.every((id) => selecionadas.includes(id));

  const alternar = (id: string) =>
    setSelecionadas((atual) =>
      atual.includes(id) ? atual.filter((outro) => outro !== id) : [...atual, id],
    );

  const reprocessarLote = async (reason: string) => {
    try {
      const desfecho = await opsApiClient.post<ReprocessBatchResult>('/ops/failures/reprocess', {
        ids: selecionadas,
        reason,
      });
      setResultado(desfecho);
      setLoteAberto(false);
      setSelecionadas([]);

      const republicadas = desfecho.items.filter((item) => item.outcome === 'republished').length;
      if (republicadas === desfecho.items.length) {
        toast.success(`${republicadas} mensagem(ns) republicada(s).`);
      } else {
        // Um lote parcial não é sucesso: o resumo por item fica na tela.
        toast.error(`${republicadas} de ${desfecho.items.length} republicada(s).`);
      }
      await reload();
    } catch (err) {
      toast.error(
        err instanceof OpsApiError ? err.message : 'Não foi possível reprocessar o lote.',
      );
    }
  };

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
    ...(podeReprocessar
      ? [
          {
            key: 'selecao',
            header: (
              <input
                type="checkbox"
                className="h-4 w-4"
                aria-label="Selecionar as pendentes desta página"
                checked={todasMarcadas}
                disabled={selecionaveis.length === 0}
                onChange={(event) => setSelecionadas(event.target.checked ? selecionaveis : [])}
              />
            ),
            cell: (falha: FailureListItem) => (
              <input
                type="checkbox"
                className="h-4 w-4"
                aria-label={`Selecionar falha ${falha.errorType}`}
                checked={selecionadas.includes(falha.id)}
                disabled={falha.status !== 'pending'}
                onChange={() => alternar(falha.id)}
              />
            ),
          } as DataTableColumn<FailureListItem>,
        ]
      : []),
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

      {selecionadas.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3">
          <p className="text-sm">
            {selecionadas.length} selecionada(s)
            {selecionadas.length >= MAX_LOTE && ` — teto de ${MAX_LOTE} por lote`}
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setLoteAberto(true)}>
              Reprocessar selecionadas
            </Button>
            <Button size="sm" variant="outline" onClick={() => setSelecionadas([])}>
              Limpar seleção
            </Button>
          </div>
        </div>
      )}

      {resultado && (
        <div className="space-y-2 rounded-lg border bg-card p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Resultado do lote</p>
            <Button size="sm" variant="ghost" onClick={() => setResultado(null)}>
              Fechar
            </Button>
          </div>

          {resultado.aborted && (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
            >
              O lote foi interrompido: {resultado.abortReason}
            </p>
          )}

          {/* Resultado POR ITEM, não um total: num lote parcial, saber quais
              passaram é a diferença entre retomar e recomeçar. */}
          <ul className="space-y-1 text-sm">
            {resultado.items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-baseline gap-2">
                <Link
                  href={`/ops/falhas/${item.id}`}
                  className="font-mono text-xs underline-offset-4 hover:underline"
                >
                  {item.id.slice(0, 8)}
                </Link>
                <span>{reprocessOutcomeLabels[item.outcome]}</span>
                {item.detail && (
                  <span className="text-xs text-muted-foreground">— {item.detail}</span>
                )}
              </li>
            ))}
          </ul>

          <Button asChild size="sm" variant="outline">
            <Link href={`/ops/auditoria?operationId=${resultado.operationId}`}>
              Ver na auditoria
            </Link>
          </Button>
        </div>
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

      <ActionDialog
        open={loteAberto}
        title={`Reprocessar ${selecionadas.length} falha(s)`}
        description="Cada payload volta para a fila de origem, um de cada vez. Se o agente ou o broker estiverem fora, o lote para e diz onde parou."
        confirmLabel="Reprocessar lote"
        onClose={() => setLoteAberto(false)}
        onConfirm={reprocessarLote}
      />
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
