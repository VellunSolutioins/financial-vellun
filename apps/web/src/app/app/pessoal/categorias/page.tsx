'use client';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Dialog } from '@/components/ui/dialog';
import { apiClient } from '@/lib/api-client';

interface Category {
  id: string;
  name: string;
  type: 'income' | 'expense' | 'transfer';
  color?: string;
  icon?: string;
  isDefault: boolean;
  profileType: string;
}

const schema = z.object({
  name: z.string().min(1, 'Nome obrigatório'),
  type: z.enum(['income', 'expense', 'transfer']),
  color: z.string().optional(),
  icon: z.string().optional(),
});
type FormData = z.infer<typeof schema>;

const typeLabels: Record<string, string> = {
  income: 'Receita',
  expense: 'Despesa',
  transfer: 'Transferência',
};

export default function CategoriasPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Category | null>(null);
  const [error, setError] = useState('');

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { type: 'expense' },
  });

  const load = () =>
    apiClient
      .get<Category[]>('/categories')
      .then(setCategories)
      .catch(console.error)
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
  }, []);

  const openNew = () => {
    setEditing(null);
    reset({ type: 'expense' });
    setModalOpen(true);
  };
  const openEdit = (c: Category) => {
    setEditing(c);
    reset({ name: c.name, type: c.type, color: c.color, icon: c.icon });
    setModalOpen(true);
  };

  const onSubmit = async (data: FormData) => {
    setError('');
    try {
      if (editing) {
        await apiClient.patch(`/categories/${editing.id}`, data);
      } else {
        await apiClient.post('/categories', data);
      }
      setModalOpen(false);
      void load();
    } catch (e: unknown) {
      if (e instanceof Error) setError(e.message);
      else setError('Erro ao salvar categoria');
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Excluir esta categoria?')) return;
    try {
      await apiClient.delete(`/categories/${id}`);
      void load();
    } catch (e: unknown) {
      if (e instanceof Error) alert(e.message);
    }
  };

  const defaults = categories.filter((c) => c.isDefault);
  const custom = categories.filter((c) => !c.isDefault);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Categorias</h1>
        <Button onClick={openNew}>+ Nova categoria</Button>
      </div>

      {loading ? (
        <div className="text-muted-foreground">Carregando...</div>
      ) : (
        <>
          {custom.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-muted-foreground mb-3">Personalizadas</h2>
              <div className="bg-white rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="text-left p-3 font-medium text-muted-foreground">Nome</th>
                      <th className="text-left p-3 font-medium text-muted-foreground">Tipo</th>
                      <th className="p-3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {custom.map((c) => (
                      <tr key={c.id} className="border-b last:border-0">
                        <td className="p-3 font-medium">
                          {c.icon} {c.name}
                        </td>
                        <td className="p-3">
                          <Badge variant="outline">{typeLabels[c.type]}</Badge>
                        </td>
                        <td className="p-3 flex gap-2 justify-end">
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
              </div>
            </div>
          )}

          <div>
            <h2 className="text-sm font-semibold text-muted-foreground mb-3">
              Padrão ({defaults.length})
            </h2>
            <div className="bg-white rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="text-left p-3 font-medium text-muted-foreground">Nome</th>
                    <th className="text-left p-3 font-medium text-muted-foreground">Tipo</th>
                  </tr>
                </thead>
                <tbody>
                  {defaults.map((c) => (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className="p-3">
                        {c.icon} {c.name}
                      </td>
                      <td className="p-3">
                        <Badge variant="secondary">{typeLabels[c.type]}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <Dialog
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Editar categoria' : 'Nova categoria'}
      >
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1">
            <Label>Nome</Label>
            <Input placeholder="Ex: Mercado, Salário..." {...register('name')} />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>
          <div className="space-y-1">
            <Label>Tipo</Label>
            <Select {...register('type')}>
              <option value="expense">Despesa</option>
              <option value="income">Receita</option>
              <option value="transfer">Transferência</option>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Ícone (emoji)</Label>
              <Input placeholder="🛒" {...register('icon')} />
            </div>
            <div className="space-y-1">
              <Label>Cor (hex)</Label>
              <Input placeholder="#3b82f6" {...register('color')} />
            </div>
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
