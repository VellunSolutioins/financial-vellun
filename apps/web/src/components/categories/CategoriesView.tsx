'use client';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ColorPicker, HEX_COLOR } from '@/components/ui/color-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Dialog } from '@/components/ui/dialog';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm';
import { cn } from '@/lib/utils';

interface Category {
  id: string;
  name: string;
  // `transfer` só em categorias antigas; não é mais aceito.
  type: 'income' | 'expense' | 'transfer';
  color?: string | null;
  costCenter?: string | null;
  isDefault: boolean;
  profileType: string;
  /** Lançamentos do usuário nesta categoria. */
  transactionCount?: number;
  /** Metas de gasto do usuário nesta categoria. */
  spendingGoalCount?: number;
}

const schema = z.object({
  name: z.string().min(1, 'Nome obrigatório'),
  type: z.enum(['income', 'expense'], { message: 'Selecione despesa ou receita' }),
  color: z.string().regex(HEX_COLOR, 'Cor inválida').or(z.literal('')),
  costCenter: z.string().optional(),
});
type FormData = z.infer<typeof schema>;

const typeLabels: Record<string, string> = {
  income: 'Receita',
  expense: 'Despesa',
  // Só para exibir categorias antigas: o tipo não é mais aceito.
  transfer: 'Transferência',
};

function plural(n: number, singular: string, pluralForm: string) {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** Bolinha com a cor da categoria. */
function CategoryMark({ category }: { category: Category }) {
  return (
    <span
      className={cn(
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
        !category.color && 'bg-muted',
      )}
      style={category.color ? { backgroundColor: `${category.color}26` } : undefined}
      aria-hidden
    >
      <span
        className="h-3 w-3 rounded-full"
        style={{ backgroundColor: category.color ?? '#94a3b8' }}
      />
    </span>
  );
}

interface Props {
  /** Exibe o campo/coluna "Centro de custo" (apenas para perfis business) */
  showCostCenter?: boolean;
}

export function CategoriesView({ showCostCenter = false }: Props) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Category | null>(null);
  const toast = useToast();
  const confirm = useConfirm();

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { type: 'expense', color: '' },
  });
  const selectedColor = watch('color');

  const load = () =>
    apiClient
      .get<Category[]>('/categories')
      .then(setCategories)
      .catch(() => toast.error('Erro ao carregar categorias'))
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openNew = () => {
    setEditing(null);
    reset({ type: 'expense', name: '', color: '', costCenter: '' });
    setModalOpen(true);
  };
  const openEdit = (c: Category) => {
    setEditing(c);
    reset({
      name: c.name,
      // Categoria antiga de transferência cai na validação e pede novo tipo.
      type: c.type as FormData['type'],
      // Cor antiga fora do formato hex não passaria na validação da API.
      color: c.color && HEX_COLOR.test(c.color) ? c.color : '',
      costCenter: c.costCenter ?? '',
    });
    setModalOpen(true);
  };

  const onSubmit = async (data: FormData) => {
    const payload = {
      name: data.name,
      type: data.type,
      // `null` limpa o campo na edição.
      color: data.color || null,
      costCenter: showCostCenter ? data.costCenter || undefined : undefined,
    };
    try {
      if (editing) {
        await apiClient.patch(`/categories/${editing.id}`, payload);
        toast.success('Categoria atualizada com sucesso.');
      } else {
        await apiClient.post('/categories', payload);
        toast.success('Categoria criada com sucesso.');
      }
      setModalOpen(false);
      void load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao salvar categoria');
    }
  };

  const remove = async (c: Category) => {
    const transactions = c.transactionCount ?? 0;
    const goals = c.spendingGoalCount ?? 0;
    const effects = [
      transactions > 0 &&
        `${plural(transactions, 'lançamento passará', 'lançamentos passarão')} para "Sem categoria".`,
      goals > 0 &&
        `${plural(goals, 'meta de gasto será excluída', 'metas de gasto serão excluídas')}.`,
    ].filter(Boolean);
    const ok = await confirm({
      title: 'Excluir categoria',
      description: [`Excluir a categoria "${c.name}"?`, ...effects].join(' '),
      confirmText: 'Excluir',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/categories/${c.id}`);
      toast.success('Categoria excluída.');
      void load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao excluir categoria');
    }
  };

  const defaults = categories.filter((c) => c.isDefault);
  const custom = categories.filter((c) => !c.isDefault);

  const details = (c: Category) =>
    [
      typeLabels[c.type],
      showCostCenter && c.costCenter,
      c.transactionCount ? plural(c.transactionCount, 'lançamento', 'lançamentos') : null,
    ]
      .filter(Boolean)
      .join(' · ');

  /**
   * Mobile: lista contínua dentro de um card (mesmo padrão de lançamentos).
   * A partir de `sm`: grade de tiles, que aproveita a largura sem esticar linhas.
   */
  const listClass =
    'divide-y divide-border overflow-hidden rounded-2xl border bg-card shadow-sm sm:grid sm:grid-cols-2 sm:gap-3 sm:divide-y-0 sm:overflow-visible sm:rounded-none sm:border-0 sm:bg-transparent sm:shadow-none lg:grid-cols-3 xl:grid-cols-4';
  const itemClass = 'flex items-center gap-3 p-4 sm:rounded-2xl sm:border sm:bg-card sm:shadow-sm';

  const section = (title: string, rows: Category[], editable: boolean) => (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-muted-foreground">
        {title} ({rows.length})
      </h2>
      <ul className={listClass}>
        {rows.map((c) => (
          <li key={c.id} className={itemClass}>
            <CategoryMark category={c} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium" title={c.name}>
                {c.name}
              </p>
              <p className="truncate text-xs text-muted-foreground">{details(c)}</p>
            </div>
            {editable && (
              <div className="-mr-2 flex shrink-0">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => openEdit(c)}
                  aria-label={`Editar ${c.name}`}
                  title="Editar"
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => void remove(c)}
                  aria-label={`Excluir ${c.name}`}
                  title="Excluir"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            )}
          </li>
        ))}
        {editable && (
          <li>
            <button
              type="button"
              onClick={openNew}
              className="flex h-full w-full items-center gap-3 p-4 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground sm:rounded-2xl sm:border sm:border-dashed"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
                <Plus className="h-4 w-4" />
              </span>
              {rows.length === 0 ? 'Criar sua primeira categoria' : 'Nova categoria'}
            </button>
          </li>
        )}
      </ul>
    </section>
  );

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">Categorias</h1>
          <p className="text-sm text-muted-foreground">Organize suas receitas e despesas.</p>
        </div>
        <Button size="sm" onClick={openNew}>
          <Plus className="mr-1 h-4 w-4" />
          Nova categoria
        </Button>
      </div>

      {loading ? (
        <div className="p-10 text-center text-sm text-muted-foreground">Carregando...</div>
      ) : (
        <div className="space-y-6">
          {section('Personalizadas', custom, true)}
          {defaults.length > 0 && section('Padrão', defaults, false)}
        </div>
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
            </Select>
            {errors.type && <p className="text-xs text-destructive">{errors.type.message}</p>}
          </div>

          <div className="space-y-2">
            <Label>Cor</Label>
            <ColorPicker
              allowEmpty
              value={selectedColor}
              onChange={(color) => setValue('color', color, { shouldDirty: true })}
            />
            {errors.color && <p className="text-xs text-destructive">{errors.color.message}</p>}
          </div>

          {showCostCenter && (
            <div className="space-y-1">
              <Label>Centro de custo</Label>
              <Input placeholder="Ex: TI, Comercial..." {...register('costCenter')} />
            </div>
          )}
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
