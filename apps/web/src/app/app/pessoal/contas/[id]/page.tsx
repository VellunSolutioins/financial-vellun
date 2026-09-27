'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { ResourcePeriodView } from '@/components/resources/ResourcePeriodView';
import { useFinancialResources } from '@/hooks/useFinancialResources';

function formatCurrency(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

/** Movimentações de uma conta comum, por período. */
export default function ContaDetalhePage() {
  const { id } = useParams<{ id: string }>();
  const { data: resources } = useFinancialResources();
  const account = resources?.accounts.find((a) => a.id === id);

  if (resources && !account) {
    return (
      <div className="space-y-4">
        <Link href="/app/pessoal/contas" className="text-sm underline">
          Voltar para Contas
        </Link>
        <p className="text-sm text-muted-foreground">Conta não encontrada.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="space-y-1">
        <Link
          href="/app/pessoal/contas"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Contas
        </Link>
        <h1 className="truncate text-xl font-bold sm:text-2xl">{account?.name ?? '...'}</h1>
      </div>

      {account && (
        <Card className="rounded-2xl">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Saldo atual</p>
            <p
              className={`text-2xl font-bold ${account.currentBalance >= 0 ? 'text-green-600' : 'text-red-600'}`}
            >
              {formatCurrency(account.currentBalance)}
            </p>
          </CardContent>
        </Card>
      )}

      <ResourcePeriodView selection={{ accountIds: [id], cardIds: [] }} />
    </div>
  );
}
