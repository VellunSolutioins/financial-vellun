import { Info } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Explica a referência de data de cada visão (docs/adrs/0018). Cada número da
 * tela diz em que data se baseia — compra e parcela nunca se somam.
 */
export function DateBasisNote({
  variant = 'competence',
  className,
}: {
  variant?: 'competence' | 'cash' | 'card' | 'due' | 'purchase';
  className?: string;
}) {
  const text = {
    competence:
      'Receitas, despesas e categorias consideram a data da compra ou da parcela, inclusive no cartão. O saldo considera só as contas.',
    cash: 'Fluxo de caixa considera só o que passou pelas contas: compra no cartão não é saída de caixa; o pagamento da fatura é.',
    card: 'Os valores deste cartão usam a data da compra ou da parcela. A fatura em que cada compra cai depende do fechamento.',
    due: 'Por vencimento: cada parcela no mês dela, cada conta no mês em que vence. Pagar não é a mesma coisa que vencer — veja a situação de cada lançamento.',
    purchase:
      'Gastos pela data da compra: a compra parcelada conta inteira no mês em que foi feita; as parcelas aparecem em Compromissos. Receitas contam quando recebidas.',
  }[variant];
  return (
    <p className={cn('flex items-start gap-1.5 text-xs text-muted-foreground', className)}>
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{text}</span>
    </p>
  );
}
