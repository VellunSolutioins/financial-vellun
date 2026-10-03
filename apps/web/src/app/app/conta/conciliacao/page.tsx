'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { useConfirm } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';
import { apiClient } from '@/lib/api-client';
import { formatDateBR } from '@/lib/utils';

interface ReviewItem {
  id: string;
  transactionId: string;
  amount: number;
  date: string;
  account: { id: string; name: string } | null;
  transaction: {
    id: string;
    type: 'income' | 'expense' | 'refund';
    description: string;
    amount: number;
    transactionDate: string;
    createdAt: string;
    category: { id: string; name: string } | null;
  };
}

interface ReviewPage {
  data: ReviewItem[];
  meta: { total: number; totalAmount: number; page: number; totalPages: number };
}

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

/**
 * Conciliação dos pagamentos que a atualização do modelo inferiu
 * (docs/adrs/0018). Antes, um lançamento com data futura entrava no saldo
 * sozinho quando a data chegava. Para não mudar o saldo de ninguém, esses
 * lançamentos ficaram como pagos — mas marcados aqui, para você confirmar ou
 * desfazer. Desfazer reabre o lançamento (em aberto, vencido) e refaz o saldo.
 */
export default function ConciliacaoPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ReviewPage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    apiClient
      .get<ReviewPage>(`/reconciliation/legacy-settlements?page=${page}`)
      .then((res) => {
        setData(res);
        if (res.data.length === 0 && page > 1) setPage(page - 1);
      })
      .catch(() => toast.error('Erro ao carregar a conciliação'));
  }, [page, toast]);
  useEffect(load, [load]);

  const act = async (item: ReviewItem, action: 'confirm' | 'undo') => {
    if (action === 'undo') {
      const ok = await confirm({
        title: 'Não foi pago',
        description: `"${item.transaction.description}" volta a ficar em aberto e ${formatCurrency(item.amount)} ${item.transaction.type === 'expense' ? 'volta ao' : 'sai do'} saldo de ${item.account?.name ?? 'sua conta'}.`,
        confirmText: 'Desfazer pagamento',
        variant: 'destructive',
      });
      if (!ok) return;
    }
    setBusy(item.id);
    try {
      await apiClient.post(`/reconciliation/legacy-settlements/${item.id}/${action}`, {});
      toast.success(action === 'confirm' ? 'Confirmado.' : 'Pagamento desfeito.');
      load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao salvar');
    } finally {
      setBusy(null);
    }
  };

  const confirmAll = async () => {
    const ok = await confirm({
      title: 'Confirmar todos',
      description: 'Todos os itens desta lista ficam como pagos/recebidos, como já estão no saldo.',
      confirmText: 'Confirmar todos',
    });
    if (!ok) return;
    try {
      await apiClient.post('/reconciliation/legacy-settlements/confirm-all', {});
      toast.success('Todos confirmados.');
      setPage(1);
      load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao confirmar');
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="space-y-1">
        <Link
          href="/app/pessoal/lancamentos"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Lançamentos
        </Link>
        <h1 className="text-xl font-bold sm:text-2xl">Conferir pagamentos</h1>
        <p className="text-sm text-muted-foreground">
          Estes lançamentos entraram no saldo só porque a data chegou — ninguém confirmou o
          pagamento. Eles continuam como pagos até você dizer o contrário.
        </p>
      </div>

      {data && data.meta.total > 0 && (
        <Card className="rounded-2xl">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm">
              {data.meta.total} {data.meta.total === 1 ? 'item' : 'itens'} ·{' '}
              {formatCurrency(data.meta.totalAmount)}
            </p>
            <Button size="sm" variant="outline" onClick={() => void confirmAll()}>
              Confirmar todos
            </Button>
          </CardContent>
        </Card>
      )}

      <Card className="rounded-2xl">
        <CardContent className="p-0">
          {!data ? (
            <p className="p-10 text-center text-sm text-muted-foreground">Carregando...</p>
          ) : data.data.length === 0 ? (
            <p className="p-10 text-center text-sm text-muted-foreground">
              Nada a conferir. Seus pagamentos estão todos confirmados.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {data.data.map((item) => (
                <li key={item.id} className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{item.transaction.description}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.transaction.type === 'income' ? 'Recebido' : 'Pago'} em{' '}
                        {formatDateBR(item.date)} · {item.account?.name ?? '—'}
                        {item.transaction.category && ` · ${item.transaction.category.name}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Cadastrado em {formatDateBR(item.transaction.createdAt)}, antes da data.
                      </p>
                    </div>
                    <span className="shrink-0 font-semibold">{formatCurrency(item.amount)}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
                    <Button
                      size="sm"
                      disabled={busy === item.id}
                      onClick={() => void act(item, 'confirm')}
                    >
                      {item.transaction.type === 'income' ? 'Foi recebido' : 'Foi pago'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === item.id}
                      onClick={() => void act(item, 'undo')}
                    >
                      {item.transaction.type === 'income' ? 'Não recebi' : 'Não paguei'}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {data && data.meta.total > 0 && (
        <Pagination
          page={data.meta.page}
          totalPages={Math.max(1, data.meta.totalPages)}
          onPageChange={setPage}
          summary={`${data.meta.total} a conferir`}
        />
      )}
    </div>
  );
}
