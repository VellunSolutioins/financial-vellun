'use client';

import { useCallback, useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { useOpsSession } from '@/contexts/ops-session-context';
import { OpsApiError, type OpsRole, opsApiClient } from '@/lib/ops-api-client';

interface Operator {
  id: string;
  githubLogin: string;
  name: string | null;
  email: string | null;
  role: OpsRole;
  canViewSensitive: boolean;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

const roleLabels: Record<OpsRole, string> = {
  viewer: 'Leitura',
  operator: 'Operador',
  ops_admin: 'Admin',
};

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Cartão de um operador, com a edição inline.
 *
 * A justificativa é campo obrigatório do formulário porque é obrigatória na API:
 * conceder ou remover acesso é uma decisão, e a trilha de auditoria precisa
 * saber por quê. Melhor pedir aqui do que devolver 400 depois de submeter.
 */
function OperatorCard({
  operator,
  isSelf,
  onSaved,
}: {
  operator: Operator;
  isSelf: boolean;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [role, setRole] = useState<OpsRole>(operator.role);
  const [active, setActive] = useState(operator.active);
  const [canViewSensitive, setCanViewSensitive] = useState(operator.canViewSensitive);
  const [reason, setReason] = useState('');

  const changed =
    role !== operator.role ||
    active !== operator.active ||
    canViewSensitive !== operator.canViewSensitive;

  const cancel = () => {
    setEditing(false);
    setRole(operator.role);
    setActive(operator.active);
    setCanViewSensitive(operator.canViewSensitive);
    setReason('');
  };

  const save = async () => {
    setSaving(true);
    try {
      await opsApiClient.patch(`/ops/operators/${operator.id}`, {
        role,
        active,
        canViewSensitive,
        reason: reason.trim(),
      });
      toast.success(`Permissões de ${operator.githubLogin} atualizadas.`);
      setEditing(false);
      setReason('');
      onSaved();
    } catch (error) {
      toast.error(
        error instanceof OpsApiError ? error.message : 'Não foi possível salvar as alterações.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-medium">{operator.githubLogin}</p>
            <p className="truncate text-xs text-muted-foreground">
              {operator.name ?? 'sem nome'} · último acesso {formatDate(operator.lastLoginAt)}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-1.5">
            <Badge variant={operator.active ? 'success' : 'secondary'}>
              {operator.active ? 'Ativo' : 'Inativo'}
            </Badge>
            <Badge variant="outline">{roleLabels[operator.role]}</Badge>
            {operator.canViewSensitive && <Badge variant="warning">Sensível</Badge>}
            {isSelf && <Badge variant="secondary">Você</Badge>}
          </div>
        </div>

        {!editing ? (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            Editar permissões
          </Button>
        ) : (
          <div className="space-y-3 border-t pt-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`role-${operator.id}`}>Papel</Label>
                <Select
                  id={`role-${operator.id}`}
                  value={role}
                  onChange={(event) => setRole(event.target.value as OpsRole)}
                >
                  <option value="viewer">Leitura</option>
                  <option value="operator">Operador</option>
                  <option value="ops_admin">Admin</option>
                </Select>
              </div>

              <fieldset className="space-y-2 sm:pt-6">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={active}
                    onChange={(event) => setActive(event.target.checked)}
                  />
                  Acesso ativo
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={canViewSensitive}
                    onChange={(event) => setCanViewSensitive(event.target.checked)}
                  />
                  Pode ver dados sensíveis
                </label>
              </fieldset>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`reason-${operator.id}`}>Justificativa</Label>
              <Input
                id={`reason-${operator.id}`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Fica registrada na auditoria"
                maxLength={500}
              />
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                size="sm"
                onClick={() => void save()}
                disabled={saving || !changed || reason.trim().length < 3}
              >
                {saving ? 'Salvando…' : 'Salvar'}
              </Button>
              <Button variant="outline" size="sm" onClick={cancel} disabled={saving}>
                Cancelar
              </Button>
            </div>
            {!changed && (
              <p className="text-xs text-muted-foreground">Altere algo para poder salvar.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function OpsOperatorsPage() {
  const { operator: current } = useOpsSession();
  const [operators, setOperators] = useState<Operator[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOperators(await opsApiClient.get<Operator[]>('/ops/operators'));
      setError(null);
    } catch (err) {
      setError(err instanceof OpsApiError ? err.message : 'Não foi possível carregar operadores.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Operadores</h1>
        <p className="text-sm text-muted-foreground">
          Quem pertence à organização entra como leitura inativo. A ativação é manual.
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

      {operators === null && !error && <p className="text-sm text-muted-foreground">Carregando…</p>}

      {operators?.length === 0 && (
        <p className="text-sm text-muted-foreground">Nenhum operador registrado.</p>
      )}

      <div className="space-y-3">
        {operators?.map((operator) => (
          <OperatorCard
            key={operator.id}
            operator={operator}
            isSelf={operator.id === current?.id}
            onSaved={() => void load()}
          />
        ))}
      </div>
    </div>
  );
}
