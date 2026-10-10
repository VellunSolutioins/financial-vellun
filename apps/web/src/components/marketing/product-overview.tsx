import { LayoutDashboard, MessageCircle, Tags, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CategoryDemo } from './product-demo';
import { container } from './styles';

/** Cada benefício descreve um recurso que existe hoje no produto. */
const BENEFITS: { icon: LucideIcon; title: string; description: string }[] = [
  {
    icon: MessageCircle,
    title: 'Menos digitação no dia a dia',
    description:
      'Mande um texto, um áudio ou a foto de um comprovante. Na foto, confirmamos os dados com você antes de registrar.',
  },
  {
    icon: Tags,
    title: 'Seus lançamentos organizados',
    description:
      'Categorias, contas, cartões e faturas no mesmo lugar, incluindo compras parceladas e despesas fixas.',
  },
  {
    icon: LayoutDashboard,
    title: 'Uma visão clara das suas finanças',
    description:
      'Veja o que entrou, quanto foi gasto em cada categoria e quais contas ainda vão vencer.',
  },
];

export function ProductOverview() {
  return (
    <section id="recursos" className="scroll-mt-16">
      <div className={cn(container, 'py-14 lg:py-24')}>
        <h2 className="max-w-2xl text-balance text-3xl font-bold tracking-tight text-ink sm:text-4xl">
          Entenda para onde seu dinheiro está indo
        </h2>
        <p className="mt-3 max-w-2xl text-lg leading-relaxed text-ink-muted">
          O painel reúne os gastos do mês por categoria, sem planilha e sem digitar tudo de novo.
        </p>
        <div className="mt-8 grid gap-6 lg:mt-12 lg:grid-cols-[1.15fr_1fr] lg:items-start lg:gap-8">
          <div className="rounded-3xl bg-surface p-4 sm:p-8">
            <CategoryDemo className="mx-auto max-w-lg" />
          </div>
          <ul className="grid gap-4">
            {BENEFITS.map((benefit) => (
              <li
                key={benefit.title}
                className="flex gap-4 rounded-3xl border bg-card p-5 shadow-soft"
              >
                <span
                  aria-hidden
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"
                >
                  <benefit.icon className="h-5 w-5" />
                </span>
                <div>
                  <h3 className="text-lg font-semibold text-ink">{benefit.title}</h3>
                  <p className="mt-1.5 text-base leading-relaxed text-ink-muted">
                    {benefit.description}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
