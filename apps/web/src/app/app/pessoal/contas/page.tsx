'use client';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { apiClient } from '@/lib/api-client';
import { CURRENCY_REGEX, currencyToNumber, maskCurrency } from '@/lib/masks';

interface Account {
  id: string;
  name: string;
  type: string;
  currentBalance: number;
  initialBalance: number;
  currency: string;
  isActive: boolean;
}

const accountTypeLabels: Record<string, string> = {
  checking: 'Conta Corrente',
  savings: 'Poupança',
  cash: 'Dinheiro',
  credit_card: 'Cartão de Crédito',
  digital_wallet: 'Carteira Digital',
  investment: 'Investimento',
  other: 'Outro',
};

const schema = z.object({
  name: z.string().min(1, 'Nome obrigatório'),
  type: z.enum([
    'checking',
    'savings',
    'cash',
    'credit_card',
    'digital_wallet',
    'investment',
    'other',
  ]),
  initialBalance: z.string().regex(CURRENCY_REGEX, 'Valor inválido').optional(),
});
type FormData = z.infer<typeof schema>;

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

export default function ContasPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [error, setError] = useState('');

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { type: 'checking', initialBalance: '0,00' },
  });

  const load = () =>
    apiClient
      .get<Account[]>('/accounts')
      .then(setAccounts)
      .catch(console.error)
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
  }, []);

  const openNew = () => {
    setEditing(null);
    reset({ type: 'checking', initialBalance: '0,00' });
    setModalOpen(true);
  };
  const openEdit = (a: Account) => {
    setEditing(a);
    reset({ name: a.name, type: a.type as FormData['type'] });
    setModalOpen(true);
  };

  const onSubmit = async (data: FormData) => {
    setError('');
    try {
      if (editing) {
        await apiClient.patch(`/accounts/${editing.id}`, { name: data.name, type: data.type });
      } else {
        await apiClient.post('/accounts', {
          name: data.name,
          type: data.type,
          initialBalance: currencyToNumber(data.initialBalance ?? '0'),
        });
      }
      setModalOpen(false);
      void load();
    } catch (e: unknown) {
      if (e instanceof Error) setError(e.message);
      else setError('Erro ao salvar conta');
    }
  };

  const deactivate = async (id: string) => {
    if (!confirm('Desativar esta conta?')) return;
    try {
      await apiClient.delete(`/accounts/${id}`);
      void load();
    } catch (e: unknown) {
      if (e instanceof Error) alert(e.message);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Contas</h1>
        <Button onClick={openNew}>+ Nova conta</Button>
      </div>

      {loading ? (
        <div className="text-muted-foreground">Carregando...</div>
      ) : accounts.length === 0 ? (
        <div className="text-muted-foreground">Nenhuma conta cadastrada.</div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {accounts.map((acc) => (
            <Card key={acc.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{acc.name}</CardTitle>
                <p className="text-xs text-muted-foreground">
                  {accountTypeLabels[acc.type] ?? acc.type}
                </p>
              </CardHeader>
              <CardContent>
                <p
                  className={`text-2xl font-bold ${Number(acc.currentBalance) >= 0 ? 'text-green-600' : 'text-red-600'}`}
                >
                  {formatCurrency(Number(acc.currentBalance))}
                </p>
                <div className="flex gap-2 mt-4">
                  <Button size="sm" variant="outline" onClick={() => openEdit(acc)}>
                    Editar
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => void deactivate(acc.id)}
                  >
                    Desativar
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Editar conta' : 'Nova conta'}
      >
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1">
            <Label>Nome</Label>
            <Input placeholder="Ex: Nubank, Carteira..." {...register('name')} />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>
          <div className="space-y-1">
            <Label>Tipo</Label>
            <Select {...register('type')}>
              {Object.entries(accountTypeLabels).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
          {!editing && (
            <div className="space-y-1">
              <Label>Saldo inicial (R$)</Label>
              <Input
                inputMode="decimal"
                placeholder="0,00"
                {...register('initialBalance')}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  const masked = maskCurrency(e.target.value);
                  e.target.value = masked;
                  setValue('initialBalance', masked, { shouldDirty: true });
                }}
              />
              {errors.initialBalance && (
                <p className="text-xs text-destructive">{errors.initialBalance.message}</p>
              )}
            </div>
          )}
          {error && (
            <p className="text-sm text-destructive bg-destructive/10 rounded p-2">{error}</p>
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
