'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { ActionDialog } from '@/components/ops/action-dialog';
import { formatDateTime } from '@/components/ops/ops-format';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DataTable, type DataTableColumn } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { useOpsSession } from '@/contexts/ops-session-context';
import { PHONE_REGEX, maskPhone } from '@/lib/masks';
import { OpsApiError, opsApiClient } from '@/lib/ops-api-client';
import type { OpsExemption } from '@/lib/ops-types';

const schema = z.object({
  name: z.string().trim().min(2, 'Nome obrigatório').max(80),
  phone: z.string().regex(PHONE_REGEX, 'WhatsApp inválido: use (00) 00000-0000'),
  note: z.string().max(500).optional(),
});
type FormData = z.infer<typeof schema>;

function toApiPayload(data: FormData) {
  return { name: data.name.trim(), phone: data.phone, note: data.note?.trim() || null };
}

/** Cadastro e edição de um número isento. A observação vai como justificativa na auditoria. */
function ExemptionFormDialog({
  open,
  exemption,
  onClose,
  onSaved,
}: {
  open: boolean;
  exemption: OpsExemption | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const editing = exemption !== null;

  const {
    register,
    handleSubmit,
    setValue,
    reset,
    formState: { errors },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  useEffect(() => {
    if (!open) return;
    reset({
      name: exemption?.name ?? '',
      phone: exemption?.phone ?? '',
      note: exemption?.note ?? '',
    });
  }, [open, exemption, reset]);

  const onSubmit = async (data: FormData) => {
    setSaving(true);
    try {
      if (exemption) {
        await opsApiClient.patch(`/ops/exemptions/${exemption.id}`, toApiPayload(data));
        toast.success(`Isenção de ${data.name.trim()} atualizada.`);
      } else {
        await opsApiClient.post('/ops/exemptions', toApiPayload(data));
        toast.success(`${data.name.trim()} isento de assinatura.`);
      }
      onSaved();
    } catch (err) {
      toast.error(err instanceof OpsApiError ? err.message : 'Não foi possível salvar a isenção.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={editing ? 'Editar isenção' : 'Novo número isento'}>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="exemption-name">Nome</Label>
          <Input id="exemption-name" placeholder="Nome da pessoa" {...register('name')} />
          {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-1">
          <Label htmlFor="exemption-phone">WhatsApp</Label>
          <Input
            id="exemption-phone"
            type="tel"
            inputMode="tel"
            placeholder="(00) 00000-0000"
            {...register('phone')}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              const masked = maskPhone(e.target.value);
              e.target.value = masked;
              setValue('phone', masked, { shouldDirty: true });
            }}
          />
          {errors.phone && <p className="text-xs text-destructive">{errors.phone.message}</p>}
        </div>

        <div className="space-y-1">
          <Label htmlFor="exemption-note">Observação (opcional)</Label>
          <Input
            id="exemption-note"
            placeholder="Ex.: sócio, equipe de suporte"
            {...register('note')}
          />
          <p className="text-xs text-muted-foreground">Fica registrada na auditoria.</p>
        </div>

        <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
          A isenção vale para a conta que verificar este WhatsApp no app (Minha Conta › Verificar
          WhatsApp). Um número só digitado no cadastro não é isento.
        </p>

        <div className="flex gap-2">
          <Button type="submit" className="flex-1" disabled={saving}>
            {saving ? 'Salvando…' : editing ? 'Salvar alterações' : 'Cadastrar'}
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RowActions({
  exemption,
  onEdit,
  onDelete,
}: {
  exemption: OpsExemption;
  onEdit: (exemption: OpsExemption) => void;
  onDelete: (exemption: OpsExemption) => void;
}) {
  return (
    <div className="flex gap-2 md:justify-end">
      <Button
        size="sm"
        variant="outline"
        className="flex-1 md:flex-none"
        onClick={() => onEdit(exemption)}
      >
        Editar
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="flex-1 text-destructive md:flex-none"
        onClick={() => onDelete(exemption)}
      >
        Excluir
      </Button>
    </div>
  );
}

export default function OpsExemptionsPage() {
  const { hasRole } = useOpsSession();
  const toast = useToast();
  const [items, setItems] = useState<OpsExemption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<OpsExemption | null>(null);
  const [deleting, setDeleting] = useState<OpsExemption | null>(null);

  const isAdmin = hasRole('ops_admin');

  const load = useCallback(async () => {
    try {
      setItems(await opsApiClient.get<OpsExemption[]>('/ops/exemptions'));
      setError(null);
    } catch (err) {
      setError(err instanceof OpsApiError ? err.message : 'Não foi possível carregar as isenções.');
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  const openForm = (exemption: OpsExemption | null) => {
    setEditing(exemption);
    setFormOpen(true);
  };

  const confirmDelete = async (reason: string) => {
    if (!deleting) return;
    try {
      await opsApiClient.delete(`/ops/exemptions/${deleting.id}`, { reason });
      toast.success(`${deleting.name} deixou de ser isento.`);
      setDeleting(null);
      void load();
    } catch (err) {
      toast.error(err instanceof OpsApiError ? err.message : 'Não foi possível excluir a isenção.');
    }
  };

  if (!isAdmin) {
    return <p className="text-sm text-muted-foreground">Só ops_admin acessa as isenções.</p>;
  }

  const columns: DataTableColumn<OpsExemption>[] = [
    { key: 'name', header: 'Nome', cell: (e) => <span className="font-medium">{e.name}</span> },
    {
      key: 'phone',
      header: 'WhatsApp',
      cell: (e) => <span className="whitespace-nowrap">{e.phone}</span>,
    },
    {
      key: 'note',
      header: 'Observação',
      cell: (e) => <span className="text-muted-foreground">{e.note ?? '—'}</span>,
    },
    {
      key: 'updated',
      header: 'Alterado',
      cell: (e) => (
        <div className="whitespace-nowrap text-xs text-muted-foreground">
          <p>{formatDateTime(e.updatedAt)}</p>
          {e.updatedBy && <p>por {e.updatedBy.githubLogin}</p>}
        </div>
      ),
    },
    {
      key: 'actions',
      align: 'right',
      cell: (e) => <RowActions exemption={e} onEdit={openForm} onDelete={setDeleting} />,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold">Isenções</h1>
          <p className="text-sm text-muted-foreground">
            Números de WhatsApp que usam o Zeloo sem assinatura, no app e no WhatsApp.
          </p>
        </div>
        <Button className="w-full sm:w-auto" onClick={() => openForm(null)}>
          Novo número
        </Button>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        >
          {error}
        </p>
      )}

      {/* Mobile: um card por número. A partir de md, tabela. */}
      <div className="space-y-3 md:hidden">
        {items === null && !error && <p className="text-sm text-muted-foreground">Carregando…</p>}
        {items?.length === 0 && (
          <p className="text-sm text-muted-foreground">Nenhum número isento.</p>
        )}
        {items?.map((e) => (
          <Card key={e.id}>
            <CardContent className="space-y-3 p-4">
              <div className="min-w-0">
                <p className="truncate font-medium">{e.name}</p>
                <p className="text-sm">{e.phone}</p>
                {e.note && <p className="text-sm text-muted-foreground">{e.note}</p>}
              </div>
              <p className="text-xs text-muted-foreground">
                Alterado em {formatDateTime(e.updatedAt)}
                {e.updatedBy ? ` por ${e.updatedBy.githubLogin}` : ''}
              </p>
              <RowActions exemption={e} onEdit={openForm} onDelete={setDeleting} />
            </CardContent>
          </Card>
        ))}
      </div>

      <DataTable
        className="hidden md:block"
        columns={columns}
        rows={items ?? []}
        rowKey={(e) => e.id}
        loading={items === null && !error}
        empty="Nenhum número isento."
      />

      <ExemptionFormDialog
        open={formOpen}
        exemption={editing}
        onClose={() => setFormOpen(false)}
        onSaved={() => {
          setFormOpen(false);
          void load();
        }}
      />

      <ActionDialog
        open={deleting !== null}
        title={`Excluir isenção de ${deleting?.name ?? ''}`}
        description="A conta deste WhatsApp volta a precisar de assinatura para usar o app e o WhatsApp."
        confirmLabel="Excluir"
        destructive
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
