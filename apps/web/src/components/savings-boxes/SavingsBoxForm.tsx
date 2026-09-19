'use client';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/components/ui/toast';
import type { SavingsBox } from '@/hooks/useSavingsBoxes';
import { CURRENCY_REGEX, currencyToNumber, formatCurrencyInput, maskCurrency } from '@/lib/masks';
import { cn } from '@/lib/utils';

const SUGGESTIONS = [
  { name: 'Reserva de emergência', color: '#10b981', recommended: true },
  { name: 'Viagem', color: '#3b82f6', recommended: false },
  { name: 'Trocar o carro', color: '#8b5cf6', recommended: false },
  { name: 'Notebook novo', color: '#f59e0b', recommended: false },
  { name: 'Casa própria', color: '#ec4899', recommended: false },
  { name: 'Presente', color: '#ef4444', recommended: false },
];

const COLORS = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899', '#ef4444', '#14b8a6', '#6366f1'];

const schema = z.object({
  name: z.string().min(1, 'Nome obrigatório'),
  color: z.string(),
  targetAmount: z
    .string()
    .optional()
    .refine((v) => !v || CURRENCY_REGEX.test(v), 'Valor inválido'),
  targetDate: z.string().optional(),
  yieldRate: z
    .string()
    .optional()
    .refine((v) => !v || (Number(v.replace(',', '.')) > 0), 'Percentual inválido'),
  yieldPeriod: z.enum(['monthly', 'annual']).optional(),
});
type FormData = z.infer<typeof schema>;

interface Props {
  box?: SavingsBox;
  onSuccess: () => void;
  onCancel: () => void;
}

export function SavingsBoxForm({ box, onSuccess, onCancel }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: box?.name ?? '',
      color: box?.color ?? COLORS[0],
      targetAmount: box?.targetAmount ? formatCurrencyInput(box.targetAmount) : '',
      targetDate: box?.targetDate ? box.targetDate.slice(0, 10) : '',
      yieldRate: box?.yieldRate ? String(box.yieldRate).replace('.', ',') : '',
      yieldPeriod: box?.yieldPeriod ?? 'monthly',
    },
  });

  const selectedColor = watch('color');
  const yieldRate = watch('yieldRate');

  const applySuggestion = (name: string, color: string) => {
    setValue('name', name, { shouldDirty: true });
    setValue('color', color, { shouldDirty: true });
  };

  const onSubmit = async (data: FormData) => {
    setSubmitting(true);
    // null (não undefined) para os opcionais: JSON.stringify remove chaves com
    // undefined, então limpar um campo na edição nunca chegaria ao backend.
    const payload = {
      name: data.name,
      color: data.color,
      targetAmount: data.targetAmount ? currencyToNumber(data.targetAmount) : null,
      targetDate: data.targetDate || null,
      yieldRate: data.yieldRate ? Number(data.yieldRate.replace(',', '.')) : null,
      yieldPeriod: data.yieldRate ? data.yieldPeriod : null,
    };
    try {
      if (box) {
        await apiClient.patch(`/savings-boxes/${box.id}`, payload);
        toast.success('Caixinha atualizada com sucesso.');
      } else {
        await apiClient.post('/savings-boxes', payload);
        toast.success('Caixinha criada com sucesso.');
      }
      onSuccess();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao salvar caixinha');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {!box && (
        <div className="space-y-1">
          <Label>Sugestões</Label>
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s.name}
                type="button"
                onClick={() => applySuggestion(s.name, s.color)}
                className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
                {s.name}
                {s.recommended && (
                  <Badge className="bg-emerald-100 text-emerald-700">Recomendado</Badge>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-1">
        <Label>Nome</Label>
        <Input placeholder="Ex: Viagem para a praia" {...register('name')} />
        {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
      </div>

      <div className="space-y-1">
        <Label>Cor</Label>
        <div className="flex flex-wrap gap-2">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setValue('color', c, { shouldDirty: true })}
              className={cn(
                'h-7 w-7 rounded-full ring-offset-2 transition-all',
                selectedColor === c && 'ring-2 ring-foreground',
              )}
              style={{ backgroundColor: c }}
              aria-label={`Cor ${c}`}
            />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label>Meta (opcional)</Label>
          <Input
            inputMode="decimal"
            placeholder="Sem alvo definido"
            {...register('targetAmount')}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              const masked = maskCurrency(e.target.value);
              e.target.value = masked;
              setValue('targetAmount', masked, { shouldDirty: true });
            }}
          />
          {errors.targetAmount && (
            <p className="text-xs text-destructive">{errors.targetAmount.message}</p>
          )}
        </div>
        <div className="space-y-1">
          <Label>Prazo (opcional)</Label>
          <Input type="date" {...register('targetDate')} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label>Rendimento % (opcional)</Label>
          <Input placeholder="Ex: 0,5" {...register('yieldRate')} />
          {errors.yieldRate && (
            <p className="text-xs text-destructive">{errors.yieldRate.message}</p>
          )}
        </div>
        <div className="space-y-1">
          <Label>Período</Label>
          <Select {...register('yieldPeriod')} disabled={!yieldRate}>
            <option value="monthly">Mensal</option>
            <option value="annual">Anual</option>
          </Select>
        </div>
      </div>

      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={submitting} className="flex-1">
          {submitting ? 'Salvando...' : box ? 'Salvar alterações' : 'Criar caixinha'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Fechar
        </Button>
      </div>
    </form>
  );
}
