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
    /** Já foi pago/recebido (a primeira ocorrência): a liquidação nasce junto. */
    settle: z.boolean(),
    /** Só no fixo: compromisso firmado (contrato) em vez de previsão cancelável. */
    committed: z.boolean(),
    /** Data do fato, quando difere do vencimento (vazio = a mesma). */
    eventDate: z.string().optional(),
  })
  .refine((data) => !data.settle || data.transactionDate <= todayInputValue(), {
    message: 'Data futura ainda não foi paga: desmarque "já foi pago" ou use a data do pagamento.',
    path: ['settle'],
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
  // Enquanto o usuário não mexe, "já foi pago" acompanha a data (passada = à vista).
  const [settleTouched, setSettleTouched] = useState(false);
  const [showEventDate, setShowEventDate] = useState(false);
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
      recurrenceMonths: '',
      settle: !transaction && !fixedOnly && !installmentOnly,
      committed: false,
      eventDate: '',
    },
  });

  const selectedType = watch('type');
  const selectedRecurrenceType = watch('recurrenceType');
  const watchedDate = watch('transactionDate');
  const watchedAccount = watch('accountId');
  const watchedSettle = watch('settle');
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
  const onCard = isCardAccount(watchedAccount);
  const isFuture = !!watchedDate && watchedDate > todayInputValue();

  // Padrão de "já foi pago": avulso em conta comum com data até hoje. Data
  // futura nunca está paga. Depois que o usuário escolhe, a escolha vale.
  useEffect(() => {
    if (transaction) return;
    if (isFuture) setValue('settle', false);
    else if (!settleTouched) setValue('settle', selectedRecurrenceType === 'avulso');
  }, [transaction, isFuture, settleTouched, selectedRecurrenceType, setValue]);

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
    setSubmitting(true);
    const {
      installments,
      recurrenceMonths,
      recurrenceType,
      recurrenceFrequency,
      settle,
      committed,
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
          // No cartão quem paga é a fatura: a API ignora, e a tela nem pergunta.
          ...(!card && { settle }),
          ...(!card && recurrenceType === 'avulso' && eventDate && { eventDate }),
          ...(recurrenceType === 'parcelado' && { installments: Number(installments) }),
          ...(recurrenceType === 'fixo' && {
            recurrenceFrequency,
            recurrenceMonths: Number(recurrenceMonths),
            forecast: !committed,
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
      {!transaction && !onCard && (
        <div className="space-y-2 rounded-md border border-border p-3">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              disabled={isFuture}
              {...register('settle', { onChange: () => setSettleTouched(true) })}
            />
            <span>
              {selectedType === 'income' ? 'Já foi recebido' : 'Já foi pago'}
              {selectedRecurrenceType !== 'avulso' && ' (a primeira)'}
              <span className="block text-xs text-muted-foreground">
                {isFuture
                  ? 'Data futura: fica em aberto até você registrar o pagamento.'
                  : watchedSettle
                    ? 'O saldo da conta muda agora.'
                    : 'Fica em aberto (e vencido, se a data passou) até você registrar o pagamento.'}
              </span>
            </span>
          </label>
          {errors.settle && <p className="text-xs text-destructive">{errors.settle.message}</p>}
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
              <label className="col-span-2 flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 h-4 w-4" {...register('committed')} />
                <span>
                  Compromisso firmado (contrato)
                  <span className="block text-xs text-muted-foreground">
                    Sem marcar, as próximas ocorrências são previsão: entram no planejamento, não na
                    dívida. Marque para aluguel, financiamento e outros contratos.
                  </span>
                </span>
              </label>
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
        {transaction && (
          <Button type="button" variant="destructive" onClick={handleCancel}>
            Cancelar
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onCancel}>
          Fechar
        </Button>
      </div>
    </form>
  );
}
