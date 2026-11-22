import { cn } from '@/lib/utils';
import { ChartBlueprint, MessageBlueprint, TagsBlueprint } from './blueprints';
import { Eyebrow } from './eyebrow';
import { Reveal } from './reveal';
import { container } from './styles';

/** Cada benefício descreve um recurso que existe hoje no produto. */
const BENEFITS = [
  {
    figure: MessageBlueprint,
    caption: 'mensagem',
    tag: 'registro',
    title: 'Menos digitação no dia a dia',
    description:
      'Mande um texto, um áudio ou a foto de um comprovante. Na foto, confirmamos os dados com você antes de registrar.',
  },
  {
    figure: TagsBlueprint,
    caption: 'categorias',
    tag: 'organização',
    title: 'Seus lançamentos organizados',
    description:
      'Categorias, contas, cartões e faturas no mesmo lugar, incluindo compras parceladas e despesas fixas.',
  },
  {
    figure: ChartBlueprint,
    caption: 'painel',
    tag: 'visão do mês',
    title: 'Uma visão clara das suas finanças',
    description:
      'Veja o que entrou, quanto foi gasto em cada categoria e quais contas ainda vão vencer.',
  },
];

/**
 * Recursos em grade de "fichas técnicas": ilustração em traço, legenda
 * `fig.` e o texto. Mobile: uma coluna; a partir do `md`, três lado a lado,
 * separadas por linhas finas.
 */
export function ProductOverview() {
  return (
    <section id="recursos" className="bg-glow-page">
      <Reveal className={cn(container, 'py-14 lg:py-24')}>
        <div className="reveal flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <Eyebrow number="02">recursos</Eyebrow>
            <h2 className="mt-3 max-w-2xl text-balance text-3xl font-medium tracking-tight text-ink sm:text-4xl">
              Entenda para onde <em className="font-bold italic">seu dinheiro está indo.</em>
            </h2>
          </div>
          <p className="max-w-md text-lg leading-relaxed text-ink-muted">
            O painel reúne os gastos do mês por categoria, sem planilha e sem digitar tudo de novo.
          </p>
        </div>

        <ul className="mt-8 grid divide-y overflow-hidden rounded-2xl border bg-card md:grid-cols-3 md:divide-x md:divide-y-0 lg:mt-12">
          {BENEFITS.map((benefit, index) => {
            const number = String(index + 2).padStart(2, '0');
            return (
              <li key={benefit.title} className="reveal flex flex-col">
                <figure className="border-b bg-surface/60 px-6 pb-3 pt-6">
                  <benefit.figure className="mx-auto max-w-[280px]" />
                  <figcaption className="mt-3 font-mono text-xs lowercase text-ink-muted">
                    fig. {number} · {benefit.caption}
                  </figcaption>
                </figure>
                <div className="flex flex-1 flex-col p-6">
                  <p className="flex justify-between font-mono text-xs lowercase text-ink-muted">
                    <span className="text-primary">{String(index + 1).padStart(2, '0')}</span>
                    <span>{benefit.tag}</span>
                  </p>
                  <h3 className="mt-3 text-xl font-semibold tracking-tight text-ink">
                    {benefit.title}
                  </h3>
                  <p className="mt-2 text-base leading-relaxed text-ink-muted">
                    {benefit.description}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </Reveal>
    </section>
  );
}
