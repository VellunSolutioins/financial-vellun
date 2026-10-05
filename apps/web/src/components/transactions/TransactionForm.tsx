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
import { useConfirm } from '@/components/ui/confirm';
import type { Transaction } from '@/hooks/useTransactions';
import { useFinancialResources } from '@/hooks/useFinancialResources';
import { ResourceSelect } from '@/components/resources/ResourceSelect';
import { CURRENCY_REGEX, currencyToNumber, formatCurrencyInput, maskCurrency } from '@/lib/masks';
import { cn } from '@/lib/utils';

const schema = z
  .object({
    type: z.enum(['income', 'expense'], { message: 'Selecione despesa ou receita' }),
    amount: z
      .string()
      .min(1, 'Valor obrigatório')
      .regex(CURRENCY_REGEX, 'Valor inválido')
      .refine((v) => currencyToNumber(v) > 0, 'Valor deve ser positivo'),
    description: z.string().min(1, 'Descrição obrigatória'),
    accountId: z.string().min(1, 'Conta ou cartão obrigatório'),
    categoryId: z.string().optional(),
    transactionDate: z.string().min(1, 'Data obrigatória'),
    recurrenceType: z.enum(['avulso', 'fixo', 'parcelado']),
    recurrenceFrequency: z.enum(['monthly', 'bimonthly', 'semiannual', 'annual']),
    installments: z.string().optional(),
    // 'auto': recorrência sem uma quantidade definida pelo usuário -- gera o
    // máximo hoje suportado (RECURRENCE_MONTHS_AUTO, 120 meses = 10 anos) por
    // baixo dos panos, já que o backend ainda não tem um job que crie a
    // próxima ocorrência mês a mês sozinho (ver onSubmit). 'custom': usuário
    // define a quantidade exata em `recurrenceMonths`.
    recurrenceMode: z.enum(['auto', 'custom']).optional(),
    recurrenceMonths: z.string().optional(),
  })
  .refine(
    (data) =>
      data.recurrenceType !== 'parcelado' ||
      (Number(data.installments) >= 2 && Number(data.installments) <= 72),
    { message: 'Informe entre 2 e 72 parcelas', path: ['installments'] },
  )
  .refine(
    (data) =>
      data.recurrenceType !== 'fixo' ||
      data.recurrenceMode !== 'custom' ||
      (Number(data.recurrenceMonths) >= 2 && Number(data.recurrenceMonths) <= 120),
    { message: 'Informe entre 2 e 120 repetições', path: ['recurrenceMonths'] },
  );
type FormData = z.infer<typeof schema>;

/** Repetições geradas quando o usuário escolhe "Recorrência" (sem definir quantidade) --
 * ver comentário de `recurrenceMode` no schema acima. */
const RECURRENCE_MONTHS_AUTO = 120;

export const recurrenceLabels: Record<FormData['recurrenceType'], string> = {
  avulso: 'Única vez',
  fixo: 'Fixo (repete)',
  parcelado: 'Parcelado',
};

export const frequencyLabels: Record<FormData['recurrenceFrequency'], string> = {
  monthly: 'Mensal',
  bimonthly: 'Bimestral',
  semiannual: 'Semestral',
  annual: 'Anual',
};

const typeOptions = [
  { value: 'expense', label: 'Despesa', active: 'border-rose-600 bg-rose-600 text-white' },
  { value: 'income', label: 'Receita', active: 'border-emerald-600 bg-emerald-600 text-white' },
] as const;

const recurrenceModeOptions = [
  { value: 'auto', label: 'Recorrência', hint: 'Repete automaticamente, sem definir quantas vezes.' },
  { value: 'custom', label: 'Repetições', hint: 'Você define a quantidade exata de repetições.' },
] as const;

interface Props {
  transaction?: Transaction;
  fixedOnly?: boolean;
  /** Tela de Parcelamentos: nasce como "parcelado" e sem o seletor de recorrência. */
  installmentOnly?: boolean;
  onSuccess: () => void;
  onCancel: () => void;
}

export function TransactionForm({
  transaction,
  fixedOnly = false,
  installmentOnly = false,
  onSuccess,
  onCancel,
}: Props) {
  const { data: resources } = useFinancialResources();
  const [categories, setCategories] = useState<{ id: string; name: string; type: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    getValues,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      // Só receita e despesa chegam aqui (estorno e pagamento abrem os detalhes).
      type: transaction?.type === 'income' ? 'income' : 'expense',
      amount: transaction ? formatCurrencyInput(Number(transaction.amount)) : '',
      description: transaction?.description ?? '',
      accountId: transaction?.accountId ?? '',
      categoryId: transaction?.categoryId ?? '',
      transactionDate: transaction?.transactionDate
        ? new Date(transaction.transactionDate).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10),
      recurrenceType: transaction
        ? 'avulso'
        : fixedOnly
          ? 'fixo'
          : installmentOnly
            ? 'parcelado'
            : 'avulso',
      recurrenceFrequency: 'monthly',
      installments: '',
      recurrenceMode: 'auto',
      recurrenceMonths: '',
    },
  });

  const selectedType = watch('type');
  const selectedRecurrenceType = watch('recurrenceType');
  const selectedRecurrenceMode = watch('recurrenceMode');
  const watchedAmount = watch('amount');
  const watchedInstallments = watch('installments');

  // Em "parcelado" o campo Valor é o TOTAL da compra e o backend reparte — a
  // prévia existe pra ninguém digitar o valor da parcela por engano.
  const isInstallment = !transaction && selectedRecurrenceType === 'parcelado';
  const installmentPreview = (() => {
    if (!isInstallment) return null;
    const total = currencyToNumber(watchedAmount ?? '');
    const count = Number(watchedInstallments);
    if (!total || !Number.isInteger(count) || count < 2 || count > 72) return null;
    // Espelha installmentAmounts() da API: base arredondada pra baixo, última
    // parcela absorve a sobra de centavos.
    const totalCents = Math.round(total * 100);
    const baseCents = Math.floor(totalCents / count);
    const lastCents = baseCents + (totalCents - baseCents * count);
    const base = formatCurrencyInput(baseCents / 100);
    const last = formatCurrencyInput(lastCents / 100);
    return baseCents === lastCents
      ? `${count}x de R$ ${base}`
      : `${count - 1}x de R$ ${base} + última de R$ ${last}`;
  })();

  useEffect(() => {
    apiClient
      .get<{ id: string; name: string; type: string }[]>('/categories')
      .then(setCategories)
      .catch(console.error);
  }, []);

  const isCardAccount = (accountId: string) =>
    !!resources?.cards.some((c) => c.accountId === accountId);

  /** Preferencial que serve para o tipo: cartão não recebe receita. */
  const preferredFor = (type: FormData['type']) => {
    const preferred = resources?.preferredAccountId ?? '';
    return type === 'income' && isCardAccount(preferred) ? '' : preferred;
  };

  // As opções chegam depois do primeiro render: reaplica a seleção quando
  // existem. Em lançamento novo, vem o preferencial — sem sobrescrever o que o
  // usuário já tiver escolhido.
  useEffect(() => {
    if (!resources) return;
    if (transaction) setValue('accountId', transaction.accountId);
    else if (!getValues('accountId')) setValue('accountId', preferredFor(getValues('type')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resources, transaction, setValue, getValues]);

  const onSubmit = async (data: FormData) => {
    const { installments, recurrenceMode, recurrenceMonths, recurrenceType, recurrenceFrequency, ...rest } =
      data;
    const payload = transaction
      ? { ...rest, amount: currencyToNumber(data.amount) }
      : {
          ...rest,
          recurrenceType,
          amount: currencyToNumber(data.amount),
          ...(recurrenceType === 'parcelado' && { installments: Number(installments) }),
          ...(recurrenceType === 'fixo' && {
            recurrenceFrequency,
            recurrenceMonths:
              recurrenceMode === 'custom' ? Number(recurrenceMonths) : RECURRENCE_MONTHS_AUTO,
          }),
        };

    // Pedido do usuário: editar uma parcela ("1/2") pergunta se descrição/categoria valem só
    // pra essa parcela ou pra compra inteira. Valor, data e conta NUNCA se propagam -- cada
    // parcela é intencionalmente independente nesses campos (é o que o backend já garante em
    // PATCH /installments/:seriesId, que só aceita description/categoryId).
    let applyToAllInstallments = false;
    if (transaction && transaction.recurrenceType === 'parcelado' && transaction.seriesId) {
      applyToAllInstallments = await confirm({
        title: 'Aplicar a todas as parcelas?',
        description: `Essa compra tem ${transaction.installmentTotal} parcelas (você está editando a ${transaction.installmentNumber}/${transaction.installmentTotal}). Descrição e categoria podem valer pra todas de uma vez; valor, data e conta sempre valem só pra esta parcela.`,
        confirmText: 'Aplicar a todas',
        cancelText: 'Somente esta parcela',
      });
    }

    setSubmitting(true);
    try {
      if (transaction) {
        await apiClient.patch(`/transactions/${transaction.id}`, payload);
        if (applyToAllInstallments) {
          await apiClient.patch(`/installments/${transaction.seriesId}`, {
            description: rest.description,
            categoryId: rest.categoryId,
          });
        }
        toast.success('Lançamento atualizado com sucesso.');
      } else {
        await apiClient.post('/transactions', payload);
        toast.success('Lançamento criado com sucesso.');
      }
      onSuccess();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao salvar lançamento');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (!transaction) return onCancel();
    const ok = await confirm({
      title: 'Cancelar lançamento',
      description: 'O lançamento ficará com status cancelado. Deseja continuar?',
      confirmText: 'Cancelar lançamento',
      cancelText: 'Voltar',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/transactions/${transaction.id}`);
      toast.success('Lançamento cancelado.');
      onSuccess();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao cancelar lançamento');
    }
  };

  const filteredCategories = categories.filter((c) => c.type === selectedType);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1">
        <Label id="transaction-type-label">Tipo</Label>
        <input type="hidden" {...register('type')} />
        <div
          role="radiogroup"
          aria-labelledby="transaction-type-label"
          className="grid grid-cols-2 gap-2"
        >
          {typeOptions.map((option) => {
            const selected = selectedType === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => {
                  if (selected) return;
                  setValue('type', option.value, { shouldDirty: true, shouldValidate: true });
                  // Categoria de despesa não serve para receita (e vice-versa).
                  setValue('categoryId', '', { shouldDirty: true });
                  // Receita não vai para cartão: troca pelo preferencial que serve.
                  const current = getValues('accountId');
                  if ((option.value === 'income' && isCardAccount(current)) || !current) {
                    setValue('accountId', preferredFor(option.value), { shouldDirty: true });
                  }
                }}
                className={cn(
                  'h-10 rounded-md border text-sm font-medium transition-colors',
                  selected
                    ? option.active
                    : 'border-input bg-background text-muted-foreground hover:bg-muted',
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        {errors.type && <p className="text-xs text-destructive">{errors.type.message}</p>}
      </div>
      <div className="space-y-1">
        <Label>{isInstallment ? 'Valor total da compra (R$)' : 'Valor (R$)'}</Label>
        <Input
          inputMode="decimal"
          placeholder="0,00"
          {...register('amount')}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            const masked = maskCurrency(e.target.value);
            e.target.value = masked;
            setValue('amount', masked, { shouldDirty: true });
          }}
        />
        {errors.amount && <p className="text-xs text-destructive">{errors.amount.message}</p>}
      </div>
      <div className="space-y-1">
        <Label>Descrição</Label>
        <Input placeholder="Ex: Supermercado, Salário..." {...register('description')} />
        {errors.description && (
          <p className="text-xs text-destructive">{errors.description.message}</p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label htmlFor="transaction-resource">Conta ou cartão</Label>
          <ResourceSelect
            id="transaction-resource"
            resources={resources}
            emptyLabel="Selecione..."
            currentValue={transaction?.accountId}
            allowCards={selectedType !== 'income'}
            {...register('accountId')}
          />
          {errors.accountId && (
            <p className="text-xs text-destructive">{errors.accountId.message}</p>
          )}
        </div>
        <div className="space-y-1">
          <Label>Categoria</Label>
          <Select {...register('categoryId')}>
            <option value="">Sem categoria</option>
            {filteredCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="space-y-1">
        <Label>Data</Label>
        <Input type="date" {...register('transactionDate')} />
        {errors.transactionDate && (
          <p className="text-xs text-destructive">{errors.transactionDate.message}</p>
        )}
      </div>
      {!transaction && (
        <div className="space-y-1">
          {/* Em Recorrências/Parcelamentos o tipo já vem no valor padrão do form: o seletor sai. */}
          {!fixedOnly && !installmentOnly && (
            <>
              <Label>Recorrência</Label>
              <Select {...register('recurrenceType')}>
                {Object.entries(recurrenceLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </>
          )}
          {selectedRecurrenceType === 'parcelado' && (
            <div className="pt-1">
              {installmentOnly && <Label htmlFor="installment-count">Número de parcelas</Label>}
              <Input
                id="installment-count"
                type="number"
                inputMode="numeric"
                min={2}
                max={72}
                placeholder="Número de parcelas"
                {...register('installments')}
              />
              {errors.installments && (
                <p className="text-xs text-destructive">{errors.installments.message}</p>
              )}
              {!errors.installments && installmentPreview && (
                <p className="pt-1 text-xs text-muted-foreground">{installmentPreview}</p>
              )}
            </div>
          )}
          {selectedRecurrenceType === 'fixo' && (
            <div className="space-y-3 pt-1">
              <div className="space-y-1">
                <Label htmlFor="recurrence-frequency">Frequência</Label>
                <Select id="recurrence-frequency" {...register('recurrenceFrequency')}>
                  {Object.entries(frequencyLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label id="recurrence-mode-label">Repetições</Label>
                <input type="hidden" {...register('recurrenceMode')} />
                <div
                  role="radiogroup"
                  aria-labelledby="recurrence-mode-label"
                  className="grid grid-cols-2 gap-2"
                >
                  {recurrenceModeOptions.map((option) => {
                    const selected = selectedRecurrenceMode === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() =>
                          setValue('recurrenceMode', option.value, {
                            shouldDirty: true,
                            shouldValidate: true,
                          })
                        }
                        className={cn(
                          'h-10 rounded-md border text-sm font-medium transition-colors',
                          selected
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-input bg-background text-muted-foreground hover:bg-muted',
                        )}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  {recurrenceModeOptions.find((o) => o.value === selectedRecurrenceMode)?.hint}
                </p>
              </div>
              {selectedRecurrenceMode === 'custom' && (
                <div className="space-y-1">
                  <Label htmlFor="recurrence-count">Quantidade de repetições</Label>
                  <Input
                    id="recurrence-count"
                    type="number"
                    inputMode="numeric"
                    min={2}
                    max={120}
                    placeholder="Ex: 12"
                    {...register('recurrenceMonths')}
                  />
                  {errors.recurrenceMonths && (
                    <p className="text-xs text-destructive">{errors.recurrenceMonths.message}</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <div className="flex flex-col gap-2 pt-2 sm:flex-row">
        <Button type="submit" disabled={submitting} className="w-full sm:flex-1">
          {submitting
            ? 'Salvando...'
            : transaction
              ? 'Salvar alterações'
              : fixedOnly
                ? 'Criar recorrência'
                : installmentOnly
                  ? 'Criar parcelamento'
                  : 'Criar lançamento'}
        </Button>
        {transaction && (
          <Button type="button" variant="destructive" onClick={handleCancel} className="w-full sm:w-auto">
            Cancelar
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onCancel} className="w-full sm:w-auto">
          Fechar
        </Button>
      </div>
    </form>
  );
}
