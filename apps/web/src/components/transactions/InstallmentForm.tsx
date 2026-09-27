'use client';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/components/ui/toast';
import type { Installment } from '@/hooks/useInstallments';

const schema = z.object({
  description: z.string().trim().min(1, 'Descrição obrigatória'),
  categoryId: z.string().optional(),
});
type FormData = z.infer<typeof schema>;

interface Props {
  installment: Installment;
  onSuccess: () => void;
  onCancel: () => void;
}

/**
 * Edita descrição e categoria de todas as parcelas. Valor, conta e número de
 * parcelas não mudam aqui: mexeriam em faturas já fechadas.
 */
export function InstallmentForm({ installment, onSuccess, onCancel }: Props) {
  const [categories, setCategories] = useState<{ id: string; name: string; type: string }[]>([]);
  const toast = useToast();

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      description: installment.description,
      categoryId: installment.categoryId ?? '',
    },
  });

  useEffect(() => {
    apiClient
      .get<{ id: string; name: string; type: string }[]>('/categories')
      .then((cat) => setCategories(cat.filter((c) => c.type === installment.type)))
      .catch(() => toast.error('Erro ao carregar categorias'));
  }, [installment.type, toast]);

  // As opções chegam depois do primeiro render: reaplica a seleção quando existem.
  useEffect(() => {
    if (categories.length) setValue('categoryId', installment.categoryId ?? '');
  }, [categories, installment.categoryId, setValue]);

  const onSubmit = async (data: FormData) => {
    try {
      await apiClient.patch(`/installments/${installment.seriesId}`, {
        description: data.description,
        categoryId: data.categoryId ?? '',
      });
      toast.success('Parcelamento atualizado.');
      onSuccess();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao atualizar parcelamento');
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
        As alterações valem para todas as {installment.parcelCount} parcelas. Para mudar o valor de
        uma parcela, edite-a na tela de Lançamentos.
      </p>
      <div className="space-y-1">
        <Label htmlFor="installment-description">Descrição</Label>
        <Input id="installment-description" {...register('description')} />
        {errors.description && (
          <p className="text-xs text-destructive">{errors.description.message}</p>
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor="installment-category">Categoria</Label>
        <Select id="installment-category" {...register('categoryId')}>
          <option value="">Sem categoria</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={isSubmitting} className="flex-1">
          {isSubmitting ? 'Salvando...' : 'Salvar alterações'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Fechar
        </Button>
      </div>
    </form>
  );
}
