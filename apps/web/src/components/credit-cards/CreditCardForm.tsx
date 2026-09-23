'use client';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/components/ui/toast';
import type { CreditCard } from '@/hooks/useCreditCards';
import { CURRENCY_REGEX, currencyToNumber, formatCurrencyInput, maskCurrency } from '@/lib/masks';
import { cn } from '@/lib/utils';

const COLORS = [
  '#8b5cf6',
  '#10b981',
  '#3b82f6',
  '#f59e0b',
  '#ec4899',
  '#ef4444',
  '#0f172a',
  '#14b8a6',
];

const schema = z.object({
  name: z.string().min(1, 'Nome obrigatório'),
  brand: z.string().optional(),
  color: z.string(),
  creditLimit: z
    .string()
    .optional()
    .refine((v) => !v || CURRENCY_REGEX.test(v), 'Valor inválido'),
  dueDay: z
    .string()
    .min(1, 'Dia obrigatório')
    .refine((v) => Number(v) >= 1 && Number(v) <= 28, 'Dia entre 1 e 28'),
});
type FormData = z.infer<typeof schema>;

interface Props {
  card?: CreditCard;
  onSuccess: () => void;
  onCancel: () => void;
}

export function CreditCardForm({ card, onSuccess, onCancel }: Props) {
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
      name: card?.name ?? '',
      brand: card?.brand ?? '',
      color: card?.color ?? COLORS[0],
      creditLimit: card?.creditLimit ? formatCurrencyInput(card.creditLimit) : '',
      dueDay: card ? String(card.dueDay) : '',
    },
  });

  const selectedColor = watch('color');

  const onSubmit = async (data: FormData) => {
    setSubmitting(true);
    // null (não undefined) para os opcionais: JSON.stringify remove chaves com
    // undefined, então limpar um campo na edição nunca chegaria ao backend.
    const payload = {
      name: data.name,
      brand: data.brand || null,
      color: data.color,
      creditLimit: data.creditLimit ? currencyToNumber(data.creditLimit) : null,
      dueDay: Number(data.dueDay),
    };
    try {
      if (card) {
        await apiClient.patch(`/credit-cards/${card.id}`, payload);
        toast.success('Cartão atualizado com sucesso.');
      } else {
        await apiClient.post('/credit-cards', payload);
        toast.success('Cartão criado com sucesso.');
      }
      onSuccess();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao salvar cartão');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1">
        <Label>Nome</Label>
        <Input placeholder="Ex: Nubank Roxo" {...register('name')} />
        {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
      </div>

      <div className="space-y-1">
        <Label>Bandeira (opcional)</Label>
        <Input placeholder="Ex: Mastercard, Visa" {...register('brand')} />
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
          <Label>Limite (opcional)</Label>
          <Input
            inputMode="decimal"
            placeholder="Sem limite definido"
            {...register('creditLimit')}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              const masked = maskCurrency(e.target.value);
              e.target.value = masked;
              setValue('creditLimit', masked, { shouldDirty: true });
            }}
          />
          {errors.creditLimit && (
            <p className="text-xs text-destructive">{errors.creditLimit.message}</p>
          )}
        </div>
        <div className="space-y-1">
          <Label>Dia de vencimento</Label>
          <Input type="number" min={1} max={28} placeholder="Ex: 10" {...register('dueDay')} />
          {errors.dueDay && <p className="text-xs text-destructive">{errors.dueDay.message}</p>}
        </div>
      </div>

      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={submitting} className="flex-1">
          {submitting ? 'Salvando...' : card ? 'Salvar alterações' : 'Criar cartão'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Fechar
        </Button>
      </div>
    </form>
  );
}
