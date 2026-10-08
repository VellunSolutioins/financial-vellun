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
import type { Transaction } from '@/hooks/useTransactions';
import { useFinancialResources } from '@/hooks/useFinancialResources';
import { ResourceSelect } from '@/components/resources/ResourceSelect';
import { CURRENCY_REGEX, currencyToNumber, formatCurrencyInput, maskCurrency } from '@/lib/masks';
import { newIdempotencyKey, todayInputValue } from '@/lib/transaction-display';
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
    recurrenceMonths: z.string().optional(),
    /** Só no fixo em conta: previsão em vez de conta a pagar ou a receber. */
    forecast: z.boolean(),
    /** Data do fato, quando difere do vencimento (vazio = a mesma). */
    eventDate: z.string().optional(),
  })
  .refine(
    (data) =>
      data.recurrenceType !== 'parcelado' ||
      (Number(data.installments) >= 2 && Number(data.installments) <= 72),
    { message: 'Informe entre 2 e 72 parcelas', path: ['installments'] },
  )
  .refine((data) => !(data.type === 'income' && data.recurrenceType === 'parcelado'), {
    message: 'Parcelamento só existe para despesas',
    path: ['recurrenceType'],
  })
  .refine(
    (data) =>
      data.recurrenceType !== 'fixo' ||
      (Number(data.recurrenceMonths) >= 2 && Number(data.recurrenceMonths) <= 120),
    { message: 'Informe entre 2 e 120 repetições', path: ['recurrenceMonths'] },
  );
type FormData = z.infer<typeof schema>;

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
  // Uma chave por abertura do formulário: duplo clique não cria dois lançamentos.
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [showEventDate, setShowEventDate] = useState(false);
  const toast = useToast();

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
      recurrenceMonths: '',
      forecast: false,
      eventDate: '',
    },
  });

  const selectedType = watch('type');
  const selectedRecurrenceType = watch('recurrenceType');
  const watchedDate = watch('transactionDate');
  const watchedAccount = watch('accountId');
  const watchedAmount = watch('amount');
  const watchedInstallments = watch('installments');
  const watchedForecast = watch('forecast');

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
  const onCard = isCardAccount(watchedAccount);
  const isFuture = !!watchedDate && watchedDate > todayInputValue();

  // Pago ou a pagar é regra, não pergunta (docs/adrs/0020): único em conta com
  // data até hoje nasce pago; data futura, parcela e fixo nascem em aberto. A
  // API aplica a regra; aqui só se diz o que vai acontecer com o saldo.
  const balanceHint = (() => {
    if (transaction || onCard) return null;
    const income = selectedType === 'income';
    if (selectedRecurrenceType === 'avulso') {
      if (isFuture) {
        return income
          ? 'Fica a receber até você marcar como recebido.'
          : 'Fica a pagar até você marcar como pago.';
      }
      return income ? 'Entra no saldo da conta agora.' : 'Sai do saldo da conta agora.';
    }
    if (selectedRecurrenceType === 'parcelado') {
      return 'Cada parcela fica a pagar: o saldo só muda quando você marcar como paga.';
    }
    if (watchedForecast) {
      return income
        ? 'Cada ocorrência fica como previsão: o saldo só muda quando você marcar como recebida.'
        : 'Cada ocorrência fica como previsão: o saldo só muda quando você marcar como paga.';
    }
    return income
      ? 'Cada ocorrência fica a receber: o saldo só muda quando você marcar como recebida.'
      : 'Cada ocorrência fica a pagar: o saldo só muda quando você marcar como paga.';
  })();

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

  // Mesma coisa para a categoria: sem isto, na edição o select ficava em "Sem
  // categoria" (as opções chegam depois) e salvar apagava a categoria.
  useEffect(() => {
    if (transaction && categories.length) setValue('categoryId', transaction.categoryId ?? '');
  }, [categories, transaction, setValue]);

  const onSubmit = async (data: FormData) => {
    setSubmitting(true);
    const {
      installments,
      recurrenceMonths,
      recurrenceType,
      recurrenceFrequency,
      forecast,
      eventDate,
      ...rest
    } = data;
    const card = isCardAccount(data.accountId);
    const payload = transaction
      ? { ...rest, amount: currencyToNumber(data.amount) }
      : {
          ...rest,
          recurrenceType,
          amount: currencyToNumber(data.amount),
          idempotencyKey,
          ...(!card && recurrenceType === 'avulso' && eventDate && { eventDate }),
          ...(recurrenceType === 'parcelado' && { installments: Number(installments) }),
          ...(recurrenceType === 'fixo' && {
            recurrenceFrequency,
            recurrenceMonths: Number(recurrenceMonths),
            // No cartão a marca não tem efeito (vale a data): a tela nem pergunta.
            ...(!card && { forecast }),
          }),
        };
    try {
      if (transaction) {
        await apiClient.patch(`/transactions/${transaction.id}`, payload);
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

  const filteredCategories = categories.filter((c) => c.type === selectedType);
  // Parcelamento só existe para despesa: parcela já gravada não vira receita.
  const lockedToExpense = installmentOnly || transaction?.recurrenceType === 'parcelado';

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
            const disabled = lockedToExpense && option.value === 'income';
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled}
                title={disabled ? 'Parcelamento só existe para despesas' : undefined}
                onClick={() => {
                  if (selected || disabled) return;
                  setValue('type', option.value, { shouldDirty: true, shouldValidate: true });
                  // Categoria de despesa não serve para receita (e vice-versa).
                  setValue('categoryId', '', { shouldDirty: true });
                  if (option.value === 'income' && getValues('recurrenceType') === 'parcelado') {
                    setValue('recurrenceType', 'avulso', { shouldDirty: true });
                  }
                  // Receita não vai para cartão: troca pelo preferencial que serve.
                  const current = getValues('accountId');
                  if ((option.value === 'income' && isCardAccount(current)) || !current) {
                    setValue('accountId', preferredFor(option.value), { shouldDirty: true });
                  }
                }}
                className={cn(
                  'h-10 rounded-md border text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
        <Label>
          {isInstallment
            ? 'Data da compra (e da 1ª parcela)'
            : selectedRecurrenceType === 'fixo' && !transaction
              ? 'Data da primeira ocorrência'
              : onCard
                ? 'Data da compra'
                : 'Data (vencimento ou previsão)'}
        </Label>
        <Input type="date" {...register('transactionDate')} />
        {errors.transactionDate && (
          <p className="text-xs text-destructive">{errors.transactionDate.message}</p>
        )}
      </div>
      {balanceHint && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{balanceHint}</p>
          {selectedRecurrenceType === 'avulso' &&
            (showEventDate ? (
              <div className="space-y-1">
                <Label htmlFor="transaction-event-date">Data do consumo (opcional)</Label>
                <Input id="transaction-event-date" type="date" {...register('eventDate')} />
                <p className="text-xs text-muted-foreground">
                  Ex.: a conta de luz de setembro que vence em outubro conta como gasto de setembro.
                </p>
              </div>
            ) : (
              <button
                type="button"
                className="text-xs text-primary underline-offset-2 hover:underline"
                onClick={() => setShowEventDate(true)}
              >
                O consumo foi em outra data?
              </button>
            ))}
        </div>
      )}
      {!transaction && (
        <div className="space-y-1">
          {/* Em Recorrências/Parcelamentos o tipo já vem no valor padrão do form: o seletor sai. */}
          {!fixedOnly && !installmentOnly && (
            <>
              <Label>Recorrência</Label>
              <Select {...register('recurrenceType')}>
                {Object.entries(recurrenceLabels)
                  .filter(([value]) => !(selectedType === 'income' && value === 'parcelado'))
                  .map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
              </Select>
              {errors.recurrenceType && (
                <p className="text-xs text-destructive">{errors.recurrenceType.message}</p>
              )}
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
            <div className="grid grid-cols-2 gap-4 pt-1">
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
                <Label htmlFor="recurrence-count">Repetições</Label>
                <Input
                  id="recurrence-count"
                  type="number"
                  inputMode="numeric"
                  min={2}
                  max={120}
                  placeholder="Ex: 12"
                  {...register('recurrenceMonths')}
                />
              </div>
              {errors.recurrenceMonths && (
                <p className="col-span-2 text-xs text-destructive">
                  {errors.recurrenceMonths.message}
                </p>
              )}
              {!onCard && (
                <label className="col-span-2 flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 h-4 w-4" {...register('forecast')} />
                  <span>
                    Previsão
                    <span className="block text-xs text-muted-foreground">
                      {selectedType === 'income'
                        ? 'Cria os lançamentos como previsão de receita, não como valor a receber. Use para entradas que podem mudar ou não acontecer. Eles aparecem como "Previsto", e o saldo só muda quando você marcar como recebido.'
                        : 'Cria os lançamentos como previsão de gasto, não como conta a pagar. Use para valores que podem mudar ou não acontecer, como o mercado do mês. Eles aparecem como "Previsto", e o saldo só muda quando você marcar como pago.'}
                    </span>
                  </span>
                </label>
              )}
            </div>
          )}
        </div>
      )}
      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={submitting} className="flex-1">
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
        {/* Cancelar e excluir ficam no rodapé do diálogo (TransactionsView): no celular, três botões não cabem numa linha. */}
        <Button type="button" variant="outline" onClick={onCancel}>
          Fechar
        </Button>
      </div>
    </form>
  );
}
