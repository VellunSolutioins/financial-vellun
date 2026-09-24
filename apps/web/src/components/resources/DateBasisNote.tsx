import { Info } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Explica a referência de data de cada visão: despesas e categorias usam a data
 * da compra ou da parcela (competência); saldo e fluxo de caixa, só contas.
 */
export function DateBasisNote({
  variant = 'competence',
  className,
}: {
  variant?: 'competence' | 'cash' | 'card';
  className?: string;
}) {
  const text = {
    competence:
      'Receitas, despesas e categorias consideram a data da compra ou da parcela, inclusive no cartão. O saldo considera só as contas.',
    cash: 'Fluxo de caixa considera só o que passou pelas contas: compra no cartão não é saída de caixa; o pagamento da fatura é.',
    card: 'Os valores deste cartão usam a data da compra ou da parcela. A fatura em que cada compra cai depende do fechamento.',
  }[variant];
  return (
    <p className={cn('flex items-start gap-1.5 text-xs text-muted-foreground', className)}>
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{text}</span>
    </p>
  );
}
