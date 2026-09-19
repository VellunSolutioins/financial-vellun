'use client';
import { useState } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { Plus, Repeat } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { RecurringRuleForm } from '@/components/recurring-rules/RecurringRuleForm';
import { useRecurringRules, type RecurringRule } from '@/hooks/useRecurringRules';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm';
import { cn } from '@/lib/utils';

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

const frequencyLabels: Record<RecurringRule['frequency'], string> = {
  monthly: 'Mensal',
  bimonthly: 'Bimestral',
  semiannual: 'Semestral',
  annual: 'Anual',
};

const CATEGORY_COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#ef4444', '#14b8a6'];

/** Cores do selo/barra de saúde por faixa de comprometimento (ver recurring-rules.service.ts). */
const healthStyles: Record<string, { bar: string; badge: string }> = {
  excelente: { bar: 'bg-emerald-500', badge: 'bg-emerald-100 text-emerald-700' },
  saudavel: { bar: 'bg-blue-500', badge: 'bg-blue-100 text-blue-700' },
  atencao: { bar: 'bg-amber-500', badge: 'bg-amber-100 text-amber-700' },
  apertado: { bar: 'bg-orange-500', badge: 'bg-orange-100 text-orange-700' },
  alto_risco: { bar: 'bg-rose-500', badge: 'bg-rose-100 text-rose-700' },
  sem_receita: { bar: 'bg-muted-foreground/40', badge: 'bg-muted text-muted-foreground' },
};

export default function RecorrenciasPage() {
  const { data, summary, loading, refetch } = useRecurringRules();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<RecurringRule | undefined>();
  const toast = useToast();
  const confirm = useConfirm();

  const openNew = () => {
    setEditingRule(undefined);
    setModalOpen(true);
  };
  const openEdit = (rule: RecurringRule) => {
    setEditingRule(rule);
    setModalOpen(true);
  };
  const closeModal = () => setModalOpen(false);
  const handleSuccess = () => {
    closeModal();
    void refetch();
  };

  const togglePause = async (rule: RecurringRule) => {
    try {
      await apiClient.patch(`/recurring-rules/${rule.id}`, { isActive: !rule.isActive });
      toast.success(rule.isActive ? 'Recorrência pausada.' : 'Recorrência reativada.');
      void refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao atualizar recorrência');
    }
  };

  const handleDelete = async (rule: RecurringRule) => {
    const ok = await confirm({
      title: 'Excluir recorrência',
      description: `Excluir "${rule.description}"? Os lançamentos já gerados não são afetados.`,
      confirmText: 'Excluir',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/recurring-rules/${rule.id}`);
      toast.success('Recorrência excluída.');
      void refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao excluir recorrência');
    }
  };

  const health = summary ? healthStyles[summary.health.key] : healthStyles.sem_receita;
  const barWidth = summary ? Math.max(0, Math.min(100, summary.percentage)) : 0;

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">Despesas Fixas e Recorrências</h1>
          <p className="text-sm text-muted-foreground">Lançamentos que se repetem automaticamente.</p>
        </div>
        <Button size="sm" onClick={openNew}>
          <Plus className="mr-1 h-4 w-4" />
          Nova recorrência
        </Button>
      </div>

      {/* Comprometido com fixos */}
      <Card className="rounded-2xl">
        <CardContent className="space-y-3 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-foreground">
                <Repeat className="h-4 w-4" />
              </span>
              <span className="text-sm text-muted-foreground">Comprometido com fixos</span>
            </div>
            <Badge className={health?.badge}>{summary?.health.label ?? '—'}</Badge>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold">{formatCurrency(summary?.committed ?? 0)}</span>
            <span className="text-sm text-muted-foreground">
              / {formatCurrency(summary?.income ?? 0)} de receita
            </span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full transition-all', health?.bar)}
              style={{ width: `${barWidth}%` }}
            />
          </div>
          {summary && summary.health.key !== 'sem_receita' && (
            <p className="text-xs text-muted-foreground">
              {summary.percentage.toFixed(0)}% da receita fixa comprometida com despesas fixas.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Divisão por categoria */}
      {summary && summary.byCategory.length > 0 && (
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="text-base">Fixos por Categoria</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col items-center gap-4 sm:flex-row">
              <ResponsiveContainer width="100%" height={180} className="sm:max-w-[180px]">
                <PieChart>
                  <Pie
                    data={summary.byCategory}
                    dataKey="total"
                    nameKey="categoryName"
                    innerRadius={45}
                    outerRadius={75}
                  >
                    {summary.byCategory.map((c, i) => (
                      <Cell key={c.categoryId ?? i} fill={c.color ?? CATEGORY_COLORS[i % CATEGORY_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: unknown) => (typeof v === 'number' ? formatCurrency(v) : String(v))} />
                </PieChart>
              </ResponsiveContainer>
              <ul className="w-full space-y-2 text-sm sm:w-auto">
                {summary.byCategory.map((c, i) => (
                  <li key={c.categoryId ?? i} className="flex items-center justify-between gap-4">
                    <span className="flex items-center gap-2 truncate">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: c.color ?? CATEGORY_COLORS[i % CATEGORY_COLORS.length] }}
                      />
                      <span className="truncate">{c.categoryName}</span>
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {formatCurrency(c.total)} · {c.percentage.toFixed(0)}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Lista */}
      <Card className="rounded-2xl">
        <CardContent className="overflow-x-auto p-0">
          {loading ? (
            <div className="p-10 text-center text-sm text-muted-foreground">Carregando...</div>
          ) : data.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              Nenhuma recorrência cadastrada ainda.
            </div>
          ) : (
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                  <th className="p-3">Descrição</th>
                  <th className="p-3">Tipo</th>
                  <th className="p-3">Frequência</th>
                  <th className="p-3">Dia</th>
                  <th className="p-3 text-right">Valor</th>
                  <th className="p-3">Status</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.map((rule) => (
                  <tr key={rule.id} className="hover:bg-muted/40">
                    <td className="p-3 font-medium">{rule.description}</td>
                    <td className="whitespace-nowrap p-3 text-muted-foreground">
                      {rule.type === 'income' ? 'Receita' : 'Despesa'}
                    </td>
                    <td className="whitespace-nowrap p-3 text-muted-foreground">
                      {frequencyLabels[rule.frequency]}
                    </td>
                    <td className="whitespace-nowrap p-3 text-muted-foreground">Dia {rule.dueDay}</td>
                    <td
                      className={cn(
                        'whitespace-nowrap p-3 text-right font-semibold',
                        rule.type === 'income' ? 'text-emerald-600' : 'text-foreground',
                      )}
                    >
                      {formatCurrency(Number(rule.amount))}
                    </td>
                    <td className="whitespace-nowrap p-3">
                      <button type="button" onClick={() => void togglePause(rule)}>
                        <Badge
                          className={
                            rule.isActive
                              ? 'cursor-pointer bg-emerald-100 text-emerald-700'
                              : 'cursor-pointer bg-muted text-muted-foreground'
                          }
                        >
                          {rule.isActive ? 'Ativa' : 'Pausada'}
                        </Badge>
                      </button>
                    </td>
                    <td className="whitespace-nowrap p-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(rule)}>
                        Editar
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => void handleDelete(rule)}
                      >
                        Excluir
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={modalOpen}
        onClose={closeModal}
        title={editingRule ? 'Editar recorrência' : 'Nova recorrência'}
      >
        <RecurringRuleForm rule={editingRule} onSuccess={handleSuccess} onCancel={closeModal} />
      </Dialog>
    </div>
  );
}
