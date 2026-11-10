'use client';

import { useCallback, useEffect, useState } from 'react';

import { ActionDialog } from '@/components/ops/action-dialog';
import { formatDateTime } from '@/components/ops/ops-format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { useOpsSession } from '@/contexts/ops-session-context';
import { OpsApiError, opsApiClient } from '@/lib/ops-api-client';
import type { OpsFeatureFlag } from '@/lib/ops-types';

/**
 * Itens do menu que não têm flag. Lista só informativa: deixa explícito para o
 * operador que estes não podem ser desligados daqui.
 */
const ESSENCIAIS = [
  'Dashboard',
  'Lançamentos',
  'Recorrências',
  'Parcelamentos',
  'Faturas',
  'Metas de gastos',
  'Cartões',
  'Contas',
  'Categorias',
];

function FlagCard({
  flag,
  canEdit,
  onToggle,
}: {
  flag: OpsFeatureFlag;
  canEdit: boolean;
  onToggle: (flag: OpsFeatureFlag) => void;
}) {
  return (
    <Card>
      <CardContent className="flex h-full flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-medium">{flag.label}</p>
            <p className="text-sm text-muted-foreground">{flag.description}</p>
          </div>
          <Badge variant={flag.enabled ? 'success' : 'warning'} className="shrink-0">
            {flag.enabled ? 'Disponível' : 'Indisponível'}
          </Badge>
        </div>

        <p className="text-xs text-muted-foreground">
          {flag.isDefault
            ? 'Nunca alterada (valor padrão).'
            : `Alterada em ${formatDateTime(flag.updatedAt)}${
                flag.updatedBy ? ` por ${flag.updatedBy.githubLogin}` : ''
              }.`}
        </p>

        <div className="mt-auto">
          <Button
            variant={flag.enabled ? 'outline' : 'default'}
            size="sm"
            className="w-full sm:w-auto"
            disabled={!canEdit}
            title={canEdit ? undefined : 'Só ops_admin pode alterar'}
            onClick={() => onToggle(flag)}
          >
            {flag.enabled ? 'Desativar' : 'Ativar'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function OpsFeatureFlagsPage() {
  const { hasRole } = useOpsSession();
  const toast = useToast();
  const [flags, setFlags] = useState<OpsFeatureFlag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<OpsFeatureFlag | null>(null);

  const canEdit = hasRole('ops_admin');

  const load = useCallback(async () => {
    try {
      setFlags(await opsApiClient.get<OpsFeatureFlag[]>('/ops/feature-flags'));
      setError(null);
    } catch (err) {
      setError(
        err instanceof OpsApiError ? err.message : 'Não foi possível carregar as funcionalidades.',
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmToggle = async (reason: string) => {
    if (!target) return;
    const enabled = !target.enabled;
    try {
      await opsApiClient.patch(`/ops/feature-flags/${target.key}`, { enabled, reason });
      toast.success(`${target.label} ${enabled ? 'disponível' : 'indisponível'} para os usuários.`);
      setTarget(null);
      void load();
    } catch (err) {
      toast.error(
        err instanceof OpsApiError ? err.message : 'Não foi possível alterar a funcionalidade.',
      );
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Funcionalidades</h1>
        <p className="text-sm text-muted-foreground">
          Liga e desliga funcionalidades do app para todos os usuários. Desligada, some do menu e a
          rota fica bloqueada. Os dados dos usuários são mantidos.
        </p>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        >
          {error}
        </p>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Controladas por flag</h2>
        {!canEdit && (
          <p className="text-xs text-muted-foreground">
            Modo leitura: só ops_admin pode ativar ou desativar.
          </p>
        )}
        {flags === null && !error && <p className="text-sm text-muted-foreground">Carregando…</p>}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {flags?.map((flag) => (
            <FlagCard key={flag.key} flag={flag} canEdit={canEdit} onToggle={setTarget} />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Sempre disponíveis</h2>
        <p className="text-xs text-muted-foreground">
          Itens essenciais do menu. Não têm flag e não podem ser desligados.
        </p>
        <ul className="flex flex-wrap gap-1.5">
          {ESSENCIAIS.map((label) => (
            <li key={label}>
              <Badge variant="secondary">{label}</Badge>
            </li>
          ))}
        </ul>
      </section>

      <ActionDialog
        open={target !== null}
        title={target?.enabled ? `Desativar ${target.label}` : `Ativar ${target?.label ?? ''}`}
        description={
          target?.enabled
            ? 'A funcionalidade some do menu de todos os usuários e a rota passa a ser bloqueada. Os dados ficam guardados e voltam ao reativar.'
            : 'A funcionalidade volta a aparecer no menu de todos os usuários.'
        }
        confirmLabel={target?.enabled ? 'Desativar' : 'Ativar'}
        destructive={target?.enabled ?? false}
        onClose={() => setTarget(null)}
        onConfirm={confirmToggle}
      />
    </div>
  );
}
