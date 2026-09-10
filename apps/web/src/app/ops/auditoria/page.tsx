'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

import { JsonBlock } from '@/components/ops/json-block';
import { formatAge, formatDateTime } from '@/components/ops/ops-format';
import { AuditResultBadge } from '@/components/ops/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { DataTable, type DataTableColumn } from '@/components/ui/table';
import { useOpsSession } from '@/contexts/ops-session-context';
import { useOpsList } from '@/hooks/use-ops-list';
import { OpsApiError, opsApiClient } from '@/lib/ops-api-client';
import {
  auditActionLabels,
  auditResultLabels,
  auditTargetLabels,
  type AuditEntry,
  type AuditEntryDetail,
} from '@/lib/ops-types';

const CAMPOS = [
  'action',
  'targetType',
  'targetId',
  'operationId',
  'operatorId',
  'result',
  'from',
  'to',
] as const;
type Campo = (typeof CAMPOS)[number];
type Filtros = Record<Campo, string>;

const VAZIO: Filtros = {
  action: '',
  targetType: '',
  targetId: '',
  operationId: '',
  operatorId: '',
  result: '',
  from: '',
  to: '',
};

interface Vocabulario {
  actions: string[];
  targetTypes: string[];
}

/**
 * Estados anterior e posterior de uma linha, sob demanda.
 *
 * Ficam fora da listagem porque carregam o retrato do alvo, e a API só os
 * devolve a `ops_admin` — por isso o botão nem aparece para os outros papéis, em
 * vez de aparecer e falhar com 403.
 */
function EstadosDaLinha({ id }: { id: string }) {
  const [detalhe, setDetalhe] = useState<AuditEntryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aberto, setAberto] = useState(false);

  const abrir = async () => {
    setAberto(true);
    if (detalhe) return;
    try {
      setDetalhe(await opsApiClient.get<AuditEntryDetail>(`/ops/audit/${id}`));
      setError(null);
    } catch (err) {
      setError(err instanceof OpsApiError ? err.message : 'Não foi possível carregar os estados.');
    }
  };

  if (!aberto) {
    return (
      <Button size="sm" variant="ghost" onClick={() => void abrir()}>
        Estados
      </Button>
    );
  }

  return (
    <div className="space-y-2 text-left">
      {error && <p className="text-xs text-destructive">{error}</p>}
      {!detalhe && !error && <p className="text-xs text-muted-foreground">Carregando…</p>}
      {detalhe && (
        <>
          <JsonBlock label="Antes" value={detalhe.beforeState} />
          <JsonBlock label="Depois" value={detalhe.afterState} />
        </>
      )}
      <Button size="sm" variant="ghost" onClick={() => setAberto(false)}>
        Recolher
      </Button>
    </div>
  );
}

function AuditoriaContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { hasRole } = useOpsSession();

  const naUrl: Filtros = { ...VAZIO };
  for (const campo of CAMPOS) naUrl[campo] = searchParams.get(campo) ?? '';

  const [rascunho, setRascunho] = useState<Filtros>(naUrl);
  const [vocabulario, setVocabulario] = useState<Vocabulario | null>(null);
  const page = Number(searchParams.get('page') ?? 1);

  const { data, loading, error, totalPages } = useOpsList<AuditEntry>('/ops/audit', {
    ...naUrl,
    page,
  });

  const carregarVocabulario = useCallback(async () => {
    try {
      setVocabulario(await opsApiClient.get<Vocabulario>('/ops/audit/vocabulary'));
    } catch {
      // O vocabulário só monta os selects. Sem ele os filtros de texto continuam
      // valendo, então falhar aqui não deve derrubar a tela.
      setVocabulario(null);
    }
  }, []);

  useEffect(() => {
    void carregarVocabulario();
  }, [carregarVocabulario]);

  const aplicar = (filtros: Filtros, novaPagina = 1) => {
    const params = new URLSearchParams();
    for (const campo of CAMPOS) {
      if (filtros[campo]) params.set(campo, filtros[campo]);
    }
    if (novaPagina > 1) params.set('page', String(novaPagina));
    router.push(params.toString() ? `/ops/auditoria?${params.toString()}` : '/ops/auditoria');
  };

  const limpar = () => {
    setRascunho(VAZIO);
    aplicar(VAZIO);
  };

  const definir = (campo: Campo, valor: string) =>
    setRascunho((atual) => ({ ...atual, [campo]: valor }));

  const podeVerEstados = hasRole('ops_admin');

  const columns: DataTableColumn<AuditEntry>[] = [
    {
      key: 'createdAt',
      header: 'Quando',
      cellClassName: 'whitespace-nowrap',
      cell: (linha) => (
        <div>
          <p>{formatDateTime(linha.createdAt)}</p>
          <p className="text-xs text-muted-foreground">{formatAge(linha.createdAt)}</p>
        </div>
      ),
    },
    {
      key: 'operator',
      header: 'Quem',
      cell: (linha) => <span className="font-medium">{linha.operator.githubLogin}</span>,
    },
    {
      key: 'action',
      header: 'Ação',
      cell: (linha) => (
        <div className="max-w-xs">
          <p className="truncate font-medium">{auditActionLabels[linha.action] ?? linha.action}</p>
          {linha.reason && <p className="truncate text-xs text-muted-foreground">{linha.reason}</p>}
        </div>
      ),
    },
    {
      key: 'target',
      header: 'Alvo',
      cell: (linha) => (
        <div className="max-w-xs">
          <p className="truncate">{auditTargetLabels[linha.targetType] ?? linha.targetType}</p>
          <p className="truncate text-xs text-muted-foreground">{linha.targetId ?? '—'}</p>
        </div>
      ),
    },
    {
      key: 'result',
      header: 'Resultado',
      cell: (linha) => <AuditResultBadge result={linha.result} />,
    },
    ...(podeVerEstados
      ? [
          {
            key: 'estados',
            align: 'right' as const,
            cell: (linha: AuditEntry) => <EstadosDaLinha id={linha.id} />,
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Auditoria</h1>
        <p className="text-sm text-muted-foreground">
          Trilha append-only: o banco recusa alterar e apagar estas linhas, inclusive para quem
          administra. Uma tentativa negada por permissão também deixa registro.
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
            <Label htmlFor="action">Ação</Label>
            <Select
              id="action"
              value={rascunho.action}
              onChange={(event) => definir('action', event.target.value)}
            >
              <option value="">Todas</option>
              {(vocabulario?.actions ?? []).map((acao) => (
                <option key={acao} value={acao}>
                  {auditActionLabels[acao] ?? acao}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="targetType">Tipo de alvo</Label>
            <Select
              id="targetType"
              value={rascunho.targetType}
              onChange={(event) => definir('targetType', event.target.value)}
            >
              <option value="">Todos</option>
              {(vocabulario?.targetTypes ?? []).map((tipo) => (
                <option key={tipo} value={tipo}>
                  {auditTargetLabels[tipo] ?? tipo}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="result">Resultado</Label>
            <Select
              id="result"
              value={rascunho.result}
              onChange={(event) => definir('result', event.target.value)}
            >
              <option value="">Todos</option>
              {Object.entries(auditResultLabels).map(([valor, rotulo]) => (
                <option key={valor} value={valor}>
                  {rotulo}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="targetId">Id do alvo</Label>
            <Input
              id="targetId"
              value={rascunho.targetId}
              onChange={(event) => definir('targetId', event.target.value)}
              placeholder="o histórico de um item só"
              maxLength={200}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="operationId">Operação</Label>
            <Input
              id="operationId"
              value={rascunho.operationId}
              onChange={(event) => definir('operationId', event.target.value)}
              placeholder="agrupa as linhas de um lote"
              maxLength={64}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="operatorId">Operador</Label>
            <Input
              id="operatorId"
              value={rascunho.operatorId}
              onChange={(event) => definir('operatorId', event.target.value)}
              placeholder="id do operador"
              maxLength={64}
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
        rowKey={(linha) => linha.id}
        loading={loading}
        minWidth={820}
        empty="Nenhuma ação com esses filtros."
      />

      {data && (
        <Pagination
          page={data.page}
          totalPages={totalPages}
          onPageChange={(nova) => aplicar(naUrl, nova)}
          summary={`${data.total} registro${data.total === 1 ? '' : 's'}`}
          disabled={loading}
        />
      )}
    </div>
  );
}

export default function OpsAuditoriaPage() {
  return (
    <Suspense>
      <AuditoriaContent />
    </Suspense>
  );
}
