'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { ActionDialog } from '@/components/ops/action-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { useOpsSession } from '@/contexts/ops-session-context';
import { formatBRL, intervalLabel } from '@/lib/billing';
import { CURRENCY_REGEX, currencyToNumber, formatCurrencyInput, maskCurrency } from '@/lib/masks';
import { OpsApiError, opsApiClient } from '@/lib/ops-api-client';
import type { OpsPlan } from '@/lib/ops-types';

const schema = z.object({
  code: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Só letras minúsculas, números e hífen (ex.: zeloo-mensal)')
    .max(60),
  name: z.string().trim().min(2, 'Nome obrigatório').max(80),
  description: z.string().max(300).optional(),
  price: z.string().regex(CURRENCY_REGEX, 'Valor inválido'),
  interval: z.enum(['monthly', 'annual']),
  isActive: z.boolean(),
  reason: z.string().trim().min(3, 'Explique o motivo (mínimo 3 caracteres)').max(500),
});
type FormData = z.infer<typeof schema>;

/** `"1.500,00"` → `"1500.00"`, o formato que a API valida. */
function toApiPayload(data: FormData) {
  return {
    name: data.name.trim(),
    description: data.description?.trim() || null,
    price: currencyToNumber(data.price).toFixed(2),
    interval: data.interval,
    isActive: data.isActive,
    reason: data.reason.trim(),
  };
}

/**
 * Cadastro e edição de um plano. O código só é informado na criação: é a
 * chave estável do plano (seed, relatórios) e não muda depois.
 */
function PlanFormDialog({
  open,
  plan,
  onClose,
  onSaved,
}: {
  open: boolean;
  plan: OpsPlan | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const editing = plan !== null;
  const hasSubscriptions = (plan?.subscriptionCount ?? 0) > 0;

  const {
    register,
    handleSubmit,
    setValue,
    reset,
    watch,
    formState: { errors },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  useEffect(() => {
    if (!open) return;
    reset({
      code: plan?.code ?? '',
      name: plan?.name ?? '',
      description: plan?.description ?? '',
      price: plan ? formatCurrencyInput(Number(plan.price)) : '',
      interval: plan?.interval ?? 'monthly',
      isActive: plan?.isActive ?? true,
      reason: '',
    });
  }, [open, plan, reset]);

  const priceChanged = editing && watch('price') !== formatCurrencyInput(Number(plan?.price ?? 0));

  const onSubmit = async (data: FormData) => {
    setSaving(true);
    try {
      if (plan) {
        await opsApiClient.patch(`/ops/plans/${plan.id}`, toApiPayload(data));
        toast.success(`Plano ${data.name.trim()} atualizado.`);
      } else {
        await opsApiClient.post('/ops/plans', { code: data.code, ...toApiPayload(data) });
        toast.success(`Plano ${data.name.trim()} criado.`);
      }
      onSaved();
    } catch (err) {
      toast.error(err instanceof OpsApiError ? err.message : 'Não foi possível salvar o plano.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={editing ? 'Editar plano' : 'Novo plano'}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="plan-code">Código</Label>
          <Input
            id="plan-code"
            placeholder="zeloo-mensal"
            autoCapitalize="none"
            readOnly={editing}
            className={editing ? 'bg-muted' : undefined}
            {...register('code')}
          />
          <p className="text-xs text-muted-foreground">
            {editing
              ? 'O código não muda depois de criado.'
              : 'Identificador estável do plano. Não muda depois de criado.'}
          </p>
          {errors.code && <p className="text-xs text-destructive">{errors.code.message}</p>}
        </div>

        <div className="space-y-1">
          <Label htmlFor="plan-name">Nome</Label>
          <Input id="plan-name" placeholder="Zeloo Mensal" {...register('name')} />
          {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-1">
          <Label htmlFor="plan-description">Descrição (opcional)</Label>
          <Input
            id="plan-description"
            placeholder="Acesso completo ao Zeloo."
            {...register('description')}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="plan-price">Preço (R$)</Label>
            <Input
              id="plan-price"
              inputMode="decimal"
              placeholder="0,00"
              {...register('price')}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                const masked = maskCurrency(e.target.value);
                e.target.value = masked;
                setValue('price', masked, { shouldDirty: true, shouldValidate: true });
              }}
            />
            {errors.price && <p className="text-xs text-destructive">{errors.price.message}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="plan-interval">Ciclo</Label>
            <Select id="plan-interval" disabled={hasSubscriptions} {...register('interval')}>
              <option value="monthly">Mensal</option>
              <option value="annual">Anual</option>
            </Select>
            {hasSubscriptions && (
              <p className="text-xs text-muted-foreground">
                Plano com assinaturas não muda de ciclo.
              </p>
            )}
          </div>
        </div>

        {priceChanged && hasSubscriptions && (
          <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
            O preço novo vale para assinaturas novas. Quem já assina continua pagando o valor
            contratado.
          </p>
        )}

        <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3">
          <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" {...register('isActive')} />
          <span className="text-sm">
            <span className="block font-medium">Exibir na tela de assinatura</span>
            <span className="block text-xs text-muted-foreground">
              Oculto, o plano não aceita assinatura nova. Quem já assina segue normalmente.
            </span>
          </span>
        </label>

        <div className="space-y-1">
          <Label htmlFor="plan-reason">Justificativa</Label>
          <Input
            id="plan-reason"
            placeholder="Por que esta alteração? Fica na auditoria."
            {...register('reason')}
          />
          {errors.reason && <p className="text-xs text-destructive">{errors.reason.message}</p>}
        </div>

        <div className="flex gap-2">
          <Button type="submit" className="flex-1" disabled={saving}>
            {saving ? 'Salvando…' : editing ? 'Salvar alterações' : 'Criar plano'}
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function PlanCard({
  plan,
  canEdit,
  onEdit,
  onDelete,
}: {
  plan: OpsPlan;
  canEdit: boolean;
  onEdit: (plan: OpsPlan) => void;
  onDelete: (plan: OpsPlan) => void;
}) {
  const inUse = plan.subscriptionCount > 0;
  return (
    <Card>
      <CardContent className="flex h-full flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-medium">{plan.name}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">{plan.code}</p>
          </div>
          <Badge variant={plan.isActive ? 'success' : 'secondary'} className="shrink-0">
            {plan.isActive ? 'Exibido' : 'Oculto'}
          </Badge>
        </div>

        <p className="text-lg font-semibold">
          {formatBRL(plan.price)}{' '}
          <span className="text-sm font-normal text-muted-foreground">
            · {intervalLabel(plan.interval)}
          </span>
        </p>
        {plan.description && <p className="text-sm text-muted-foreground">{plan.description}</p>}
        <p className="text-xs text-muted-foreground">
          {inUse
            ? `${plan.subscriptionCount} assinatura${plan.subscriptionCount === 1 ? '' : 's'}`
            : 'Nenhuma assinatura'}
        </p>

        {canEdit && (
          <div className="mt-auto flex flex-wrap gap-2">
            <Button size="sm" variant="outline" className="flex-1" onClick={() => onEdit(plan)}>
              Editar
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="flex-1 text-destructive"
              disabled={inUse}
              title={inUse ? 'Plano com assinaturas: oculte em vez de excluir' : undefined}
              onClick={() => onDelete(plan)}
            >
              Excluir
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function OpsPlansPage() {
  const { hasRole } = useOpsSession();
  const toast = useToast();
  const [plans, setPlans] = useState<OpsPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<OpsPlan | null>(null);
  const [deleting, setDeleting] = useState<OpsPlan | null>(null);

  const canEdit = hasRole('ops_admin');

  const load = useCallback(async () => {
    try {
      setPlans(await opsApiClient.get<OpsPlan[]>('/ops/plans'));
      setError(null);
    } catch (err) {
      setError(err instanceof OpsApiError ? err.message : 'Não foi possível carregar os planos.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openForm = (plan: OpsPlan | null) => {
    setEditing(plan);
    setFormOpen(true);
  };

  const confirmDelete = async (reason: string) => {
    if (!deleting) return;
    try {
      await opsApiClient.delete(`/ops/plans/${deleting.id}`, { reason });
      toast.success(`Plano ${deleting.name} excluído.`);
      setDeleting(null);
      void load();
    } catch (err) {
      toast.error(err instanceof OpsApiError ? err.message : 'Não foi possível excluir o plano.');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold">Planos</h1>
          <p className="text-sm text-muted-foreground">
            Planos de assinatura. Os exibidos aparecem na tela de assinatura do app.
          </p>
        </div>
        {canEdit && (
          <Button className="w-full sm:w-auto" onClick={() => openForm(null)}>
            Novo plano
          </Button>
        )}
      </div>

      {!canEdit && (
        <p className="text-xs text-muted-foreground">
          Modo leitura: só ops_admin cadastra e altera planos.
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        >
          {error}
        </p>
      )}

      {plans === null && !error && <p className="text-sm text-muted-foreground">Carregando…</p>}
      {plans?.length === 0 && (
        <p className="text-sm text-muted-foreground">Nenhum plano cadastrado.</p>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {plans?.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            canEdit={canEdit}
            onEdit={openForm}
            onDelete={setDeleting}
          />
        ))}
      </div>

      <PlanFormDialog
        open={formOpen}
        plan={editing}
        onClose={() => setFormOpen(false)}
        onSaved={() => {
          setFormOpen(false);
          void load();
        }}
      />

      <ActionDialog
        open={deleting !== null}
        title={`Excluir ${deleting?.name ?? 'plano'}`}
        description="O plano sai do cadastro. Só é possível porque nenhuma assinatura o usou."
        confirmLabel="Excluir"
        destructive
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
