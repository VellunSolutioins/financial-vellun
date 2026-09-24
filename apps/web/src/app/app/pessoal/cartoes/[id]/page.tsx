'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, CreditCard as CreditCardIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { ResourcePeriodView } from '@/components/resources/ResourcePeriodView';
import type { CreditCard } from '@/hooks/useCreditCards';
import { apiClient } from '@/lib/api-client';

/** Um cartão: lançamentos por período (competência). */
export default function CartaoDetalhePage() {
  const { id } = useParams<{ id: string }>();
  const [card, setCard] = useState<CreditCard | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    apiClient
      .get<CreditCard>(`/credit-cards/${id}`)
      .then(setCard)
      .catch(() => setNotFound(true));
  }, [id]);

  if (notFound) {
    return (
      <div className="space-y-4">
        <Link href="/app/pessoal/cartoes" className="text-sm underline">
          Voltar para Cartões
        </Link>
        <p className="text-sm text-muted-foreground">Cartão não encontrado.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="space-y-1">
        <Link
          href="/app/pessoal/cartoes"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Cartões
        </Link>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white"
            style={{ backgroundColor: card?.color ?? '#94a3b8' }}
          >
            <CreditCardIcon className="h-4 w-4" />
          </span>
          <h1 className="min-w-0 truncate text-xl font-bold sm:text-2xl">{card?.name ?? '...'}</h1>
          {card && !card.isActive && <Badge variant="secondary">Arquivado</Badge>}
          {card?.needsSetup && <Badge variant="warning">Configurar fechamento</Badge>}
        </div>
        {card && !card.needsSetup && (
          <p className="text-sm text-muted-foreground">
            Fecha dia {card.closingDay} · vence dia {card.dueDay}
          </p>
        )}
      </div>

      <ResourcePeriodView selection={{ accountIds: [], cardIds: [id] }} basis="card" />
    </div>
  );
}
