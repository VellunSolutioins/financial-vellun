'use client';
import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';
import { DataTable, type DataTableColumn } from '@/components/ui/table';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm';
import { CPF_CNPJ_REGEX, PHONE_REGEX, maskCpfCnpj, maskPhone } from '@/lib/masks';

export interface Contact {
  id: string;
  name: string;
  type: 'client' | 'supplier';
  document?: string | null;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
}

const schema = z.object({
  name: z.string().min(1, 'Nome obrigatório'),
  document: z.string().regex(CPF_CNPJ_REGEX, 'CPF/CNPJ inválido').optional().or(z.literal('')),
  email: z.string().email('E-mail inválido').optional().or(z.literal('')),
  phone: z.string().regex(PHONE_REGEX, 'Telefone inválido').optional().or(z.literal('')),
  notes: z.string().optional(),
});
type FormData = z.infer<typeof schema>;

interface Props {
  type: 'client' | 'supplier';
  title: string;
  /** Rótulo no singular, ex.: "cliente" / "fornecedor" */
  singular: string;
}

export function ContactsView({ type, title, singular }: Props) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const toast = useToast();
  const confirm = useConfirm();
  const Singular = singular.charAt(0).toUpperCase() + singular.slice(1);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    trigger,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ type });
    if (search) params.set('search', search);
    return apiClient
      .get<Contact[]>(`/contacts?${params}`)
      .then(setContacts)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [type, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const openNew = () => {
    setEditing(null);
    reset({ name: '', document: '', email: '', phone: '', notes: '' });
    setModalOpen(true);
  };
  const openEdit = (c: Contact) => {
    setEditing(c);
    reset({
      name: c.name,
      document: c.document ? maskCpfCnpj(c.document) : '',
      email: c.email ?? '',
      phone: c.phone ? maskPhone(c.phone) : '',
      notes: c.notes ?? '',
    });
    setModalOpen(true);
  };

  const onSubmit = async (data: FormData) => {
    const payload = {
      ...data,
      type,
      email: data.email || undefined,
      document: data.document || undefined,
      phone: data.phone || undefined,
      notes: data.notes || undefined,
    };
    try {
      if (editing) {
        await apiClient.patch(`/contacts/${editing.id}`, payload);
        toast.success(`${Singular} atualizado com sucesso.`);
      } else {
        await apiClient.post('/contacts', payload);
        toast.success(`${Singular} cadastrado com sucesso.`);
      }
      setModalOpen(false);
      void load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : `Erro ao salvar ${singular}`);
    }
  };

  const remove = async (id: string) => {
    const ok = await confirm({
      title: `Excluir ${singular}`,
      description: `Tem certeza que deseja excluir este ${singular}?`,
      confirmText: 'Excluir',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/contacts/${id}`);
      toast.success(`${Singular} excluído.`);
      void load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : `Erro ao excluir ${singular}`);
    }
  };

  const columns: DataTableColumn<Contact>[] = [
    { key: 'name', header: 'Nome', cellClassName: 'font-medium', cell: (c) => c.name },
    {
      key: 'document',
      header: 'Documento',
      cellClassName: 'text-muted-foreground',
      cell: (c) => c.document ?? '—',
    },
    {
      key: 'email',
      header: 'E-mail',
      cellClassName: 'text-muted-foreground',
      cell: (c) => c.email ?? '—',
    },
    {
      key: 'phone',
      header: 'Telefone',
      cellClassName: 'text-muted-foreground',
      cell: (c) => c.phone ?? '—',
    },
    {
      key: 'acoes',
      align: 'right',
      cellClassName: 'whitespace-nowrap',
      cell: (c) => (
        <>
          <Button size="sm" variant="ghost" onClick={() => openEdit(c)}>
            Editar
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            onClick={() => void remove(c.id)}
          >
            Excluir
          </Button>
        </>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold">{title}</h1>
        <Button onClick={openNew}>+ Novo {singular}</Button>
      </div>

      <Input
        placeholder="Buscar por nome..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-sm"
      />

      <DataTable
        columns={columns}
        rows={contacts}
        rowKey={(c) => c.id}
        loading={loading}
        minWidth={640}
        empty={`Nenhum ${singular} cadastrado.`}
      />

      <Dialog
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? `Editar ${singular}` : `Novo ${singular}`}
      >
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1">
            <Label>Nome</Label>
            <Input placeholder="Nome ou razão social" {...register('name')} />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>
          <div className="space-y-1">
            <Label>Documento (CNPJ/CPF)</Label>
            <Input
              placeholder="00.000.000/0000-00"
              {...register('document')}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                const masked = maskCpfCnpj(e.target.value);
                e.target.value = masked;
                setValue('document', masked, { shouldDirty: true });
              }}
            />
            {errors.document && (
              <p className="text-xs text-destructive">{errors.document.message}</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>E-mail</Label>
              <Input
                type="email"
                placeholder="email@exemplo.com"
                {...register('email', { onBlur: () => void trigger('email') })}
              />
              {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
            </div>
            <div className="space-y-1">
              <Label>Telefone</Label>
              <Input
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
          </div>
          <div className="space-y-1">
            <Label>Observações</Label>
            <Input placeholder="Notas internas..." {...register('notes')} />
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={isSubmitting} className="flex-1">
              {isSubmitting ? 'Salvando...' : 'Salvar'}
            </Button>
            <Button type="button" variant="outline" onClick={() => setModalOpen(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
