'use client';
import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';
import { apiClient } from '@/lib/api-client';

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
  document: z.string().optional(),
  email: z.string().email('E-mail inválido').optional().or(z.literal('')),
  phone: z.string().optional(),
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
  const [error, setError] = useState('');

  const {
    register,
    handleSubmit,
    reset,
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
    setError('');
    setModalOpen(true);
  };
  const openEdit = (c: Contact) => {
    setEditing(c);
    reset({
      name: c.name,
      document: c.document ?? '',
      email: c.email ?? '',
      phone: c.phone ?? '',
      notes: c.notes ?? '',
    });
    setError('');
    setModalOpen(true);
  };

  const onSubmit = async (data: FormData) => {
    setError('');
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
      } else {
        await apiClient.post('/contacts', payload);
      }
      setModalOpen(false);
      void load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : `Erro ao salvar ${singular}`);
    }
  };

  const remove = async (id: string) => {
    if (!confirm(`Excluir este ${singular}?`)) return;
    try {
      await apiClient.delete(`/contacts/${id}`);
      void load();
    } catch (e: unknown) {
      if (e instanceof Error) alert(e.message);
    }
  };

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

      <div className="bg-white rounded-lg border overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground">Carregando...</div>
        ) : contacts.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">Nenhum {singular} cadastrado.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left p-3 font-medium text-muted-foreground">Nome</th>
                <th className="text-left p-3 font-medium text-muted-foreground">Documento</th>
                <th className="text-left p-3 font-medium text-muted-foreground">E-mail</th>
                <th className="text-left p-3 font-medium text-muted-foreground">Telefone</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="p-3 font-medium">{c.name}</td>
                  <td className="p-3 text-muted-foreground">{c.document ?? '—'}</td>
                  <td className="p-3 text-muted-foreground">{c.email ?? '—'}</td>
                  <td className="p-3 text-muted-foreground">{c.phone ?? '—'}</td>
                  <td className="p-3 text-right whitespace-nowrap">
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

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
            <Input placeholder="00.000.000/0000-00" {...register('document')} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>E-mail</Label>
              <Input type="email" placeholder="email@exemplo.com" {...register('email')} />
              {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
            </div>
            <div className="space-y-1">
              <Label>Telefone</Label>
              <Input placeholder="(00) 00000-0000" {...register('phone')} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Observações</Label>
            <Input placeholder="Notas internas..." {...register('notes')} />
          </div>
          {error && <p className="text-sm text-destructive bg-destructive/10 rounded p-2">{error}</p>}
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
