import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type { CreditCard } from '@/hooks/useCreditCards';
import { cn } from '@/lib/utils';
import { formatCurrency } from './invoice-labels';

/** Cores da barra por faixa de uso do limite (ver credit-cards.service.ts). */
const healthBarStyles: Record<string, string> = {
  tranquilo: 'bg-emerald-500',
  saudavel: 'bg-blue-500',
  atencao: 'bg-amber-500',
  apertado: 'bg-orange-500',
  no_limite: 'bg-rose-500',
  limite_atingido: 'bg-rose-600',
};

/**
 * Uso do limite em linguagem comum (docs/adrs/0020): quanto está usado, quanto
 * sobra e por quê — sem "dívida efetiva", "saldo credor" ou "previsto". Mesmo
 * conteúdo na tela Cartões e na tela Faturas.
 */
export function CardLimitDetails({ card, editHref }: { card: CreditCard; editHref?: string }) {
  const used = card.committed ?? 0;
  const barWidth =
    card.creditLimit && card.creditLimit > 0
      ? Math.max(0, Math.min(100, (used / card.creditLimit) * 100))
      : 0;

  return (
    <div className="space-y-3">
      {card.creditLimit === null ? (
        <p className="text-sm">
          Limite não informado.
          {editHref && (
            <>
              {' '}
              <Link href={editHref} className="font-medium underline">
                Editar o cartão
              </Link>
            </>
          )}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm text-muted-foreground">Usado</span>
            <span className="text-2xl font-bold">{formatCurrency(used)}</span>
            <span className="text-sm text-muted-foreground">
              de {formatCurrency(card.creditLimit)}
            </span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                card.health ? healthBarStyles[card.health.key] : 'bg-primary',
              )}
              style={{ width: `${barWidth}%` }}
            />
          </div>
          <p className="text-sm">
            Disponível <span className="font-semibold">{formatCurrency(card.available ?? 0)}</span>
          </p>
        </>
      )}

      {(card.futureInstallments ?? 0) > 0 && (
        <p className="text-xs text-muted-foreground">
          Parcelas que ainda vão vencer também ocupam o limite (
          {formatCurrency(card.futureInstallments ?? 0)}).
        </p>
      )}
      {(card.credit ?? 0) > 0 && (
        <p className="text-xs text-emerald-700">
          Você tem {formatCurrency(card.credit ?? 0)} de crédito neste cartão.
        </p>
      )}
      {(card.forecast ?? 0) > 0 && (
        <p className="text-xs text-muted-foreground">
          Assinaturas que ainda vão cair: {formatCurrency(card.forecast ?? 0)}.
        </p>
      )}
    </div>
  );
}

/** Card "Limite do cartão" da tela Faturas. */
export function CardLimitCard({ card }: { card: CreditCard }) {
  return (
    <Card className="rounded-2xl">
      <CardContent className="space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">Limite do cartão</span>
          {card.health && card.creditLimit !== null && (
            <Badge className="shrink-0 bg-muted text-foreground">
              {card.health.emoji} {card.health.label}
            </Badge>
          )}
        </div>
        <CardLimitDetails card={card} editHref="/app/pessoal/cartoes" />
        {card.creditLimit !== null && (
          <p className="text-[11px] text-muted-foreground">
            O banco pode liberar o limite em outro momento: o disponível é uma estimativa.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
