'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { demoVerification } from './demo-data';
import { Eyebrow } from './eyebrow';
import { CategoryDemo, ChatPanel, ProductDemo } from './product-demo';
import { Reveal } from './reveal';
import { container, focusRing } from './styles';

interface Step {
  tab: string;
  title: string;
  description: string;
  /** Linhas "chave valor" do extrato; só fatos verificáveis do produto. */
  facts: [string, string][];
  preview: React.ReactNode;
}

const STEPS: Step[] = [
  {
    tab: 'Conecte',
    title: 'Conecte seu WhatsApp',
    description:
      'Crie sua conta e confirme seu número enviando um código para o nosso WhatsApp. É assim que reconhecemos as suas mensagens.',
    facts: [
      ['onde', 'app e WhatsApp'],
      ['precisa', 'código de 6 dígitos'],
    ],
    preview: (
      <Reveal group className="mx-auto w-full max-w-md">
        <ChatPanel chat={demoVerification} />
      </Reveal>
    ),
  },
  {
    tab: 'Envie',
    title: 'Envie seus lançamentos',
    description:
      'Escreva como você fala: “gastei 100 no mercado” ou “recebi 5000 de salário”. Se faltar alguma informação, perguntamos antes de registrar.',
    facts: [
      ['onde', 'WhatsApp'],
      ['formato', 'texto, áudio ou foto'],
    ],
    preview: <ProductDemo compact />,
  },
  {
    tab: 'Acompanhe',
    title: 'Acompanhe suas finanças',
    description:
      'Cada lançamento aparece no aplicativo, organizado por categoria, junto com o painel do seu mês.',
    facts: [
      ['onde', 'aplicativo'],
      ['mostra', 'gastos por categoria'],
    ],
    preview: <CategoryDemo className="mx-auto max-w-md" />,
  },
];

/**
 * A partir daqui a seção fica presa na tela e a rolagem troca de etapa. Igual
 * à variante `pin:` do `tailwind.config.ts`: desktop com altura para a janela.
 */
const PINNED_QUERY = '(min-width: 1024px) and (min-height: 760px)';

/** Onde o painel fixa (`pin:top-16`): logo abaixo do cabeçalho de 64 px. */
const STICKY_TOP = 64;

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * "Como funciona" como uma janela com uma aba por etapa: à esquerda, a etapa
 * em formato de extrato (linhas numeradas); à direita, a prévia do que a
 * pessoa vê. Mobile e tablet: abas por toque, sem prender a rolagem. Desktop:
 * a seção fica fixa enquanto a rolagem passa pelas três etapas (as abas também
 * funcionam por clique e por teclado).
 */
export function HowItWorks() {
  const [active, setActive] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const baseId = useId();

  /**
   * Faixa de rolagem em que a seção fica presa (desktop): começa quando o topo
   * dela chega a STICKY_TOP e termina quando o fim dela sai por baixo do painel.
   */
  const pinnedRange = useCallback(() => {
    const el = sectionRef.current;
    if (!el) return null;
    const top = el.getBoundingClientRect().top + window.scrollY - STICKY_TOP;
    return { top, range: Math.max(1, el.offsetHeight - (window.innerHeight - STICKY_TOP)) };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia(PINNED_QUERY);
    let raf = 0;
    const update = () => {
      if (!mq.matches) return;
      const pinned = pinnedRange();
      if (!pinned) return;
      const p = (window.scrollY - pinned.top) / pinned.range;
      const index = Math.min(STEPS.length - 1, Math.max(0, Math.floor(p * STEPS.length)));
      setActive(index);
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    mq.addEventListener('change', update);
    update();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      mq.removeEventListener('change', update);
    };
  }, [pinnedRange]);

  const select = (index: number) => {
    setActive(index);
    // No desktop, a aba escolhida leva a rolagem até o trecho dela.
    const pinned = window.matchMedia(PINNED_QUERY).matches ? pinnedRange() : null;
    if (pinned) {
      // Salto direto: a janela fica parada na tela, só o conteúdo troca. Uma
      // rolagem suave passaria pelas etapas do meio e as abas piscariam.
      window.scrollTo({
        top: pinned.top + (pinned.range * (index + 0.5)) / STEPS.length,
        behavior: 'instant',
      });
    }
  };

  const onTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    const last = STEPS.length - 1;
    const next =
      e.key === 'ArrowRight'
        ? (index + 1) % STEPS.length
        : e.key === 'ArrowLeft'
          ? (index - 1 + STEPS.length) % STEPS.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null;
    if (next === null) return;
    e.preventDefault();
    select(next);
    tabRefs.current[next]?.focus();
  };

  const step = STEPS[active];
  const tabId = (i: number) => `${baseId}-tab-${i}`;
  const panelId = `${baseId}-panel`;

  return (
    <section id="como-funciona" ref={sectionRef} className="bg-surface pin:h-[260vh]">
      <div className="bg-glow-surface pin:sticky pin:top-16 pin:flex pin:h-[calc(100svh-4rem)] pin:flex-col pin:justify-center">
        <div className={cn(container, 'py-14 pin:py-4')}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <Eyebrow number="01">como funciona</Eyebrow>
              <h2 className="mt-3 text-balance text-3xl font-medium tracking-tight text-ink sm:text-4xl">
                Três passos, <em className="text-emphasis">da mensagem ao painel.</em>
              </h2>
            </div>
            <p className="font-mono text-xs lowercase text-primary">uma etapa por vez</p>
          </div>

          <div className="mt-8 overflow-hidden rounded-2xl border bg-card shadow-soft pin:mt-5">
            <div
              role="tablist"
              aria-label="Etapas"
              className="flex overflow-x-auto border-b [scrollbar-width:none]"
            >
              {STEPS.map((s, i) => {
                const selected = i === active;
                return (
                  <button
                    key={s.tab}
                    ref={(el) => {
                      tabRefs.current[i] = el;
                    }}
                    id={tabId(i)}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={panelId}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => select(i)}
                    onKeyDown={(e) => onTabKeyDown(e, i)}
                    className={cn(
                      // Mobile: as três dividem a largura; a partir do `sm`, cada uma no seu tamanho.
                      'relative flex min-h-12 flex-1 items-center justify-center gap-2 border-r px-2 text-sm font-medium text-ink-muted last:border-r-0 hover:text-ink sm:flex-none sm:justify-start sm:px-5 sm:last:border-r',
                      selected &&
                        "bg-primary/[0.08] text-ink after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary after:content-['']",
                      focusRing,
                      'focus-visible:ring-inset focus-visible:ring-offset-0',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        selected ? 'bg-primary' : 'bg-transparent',
                      )}
                    />
                    <span
                      className={cn(
                        'hidden font-mono text-xs sm:inline',
                        selected && 'text-primary',
                      )}
                    >
                      {pad(i + 1)}
                    </span>
                    {s.tab}
                  </button>
                );
              })}
            </div>

            {/* Progresso das etapas, na cor da marca. */}
            <div className="h-1 bg-muted" aria-hidden>
              <div
                className="h-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none"
                style={{ width: `${((active + 1) / STEPS.length) * 100}%` }}
              />
            </div>

            <div
              id={panelId}
              role="tabpanel"
              aria-labelledby={tabId(active)}
              // Altura fixa no modo preso: as etapas não mudam o tamanho da janela.
              className="grid lg:grid-cols-[1fr_1.1fr] pin:h-[31rem]"
            >
              {/* Extrato: linhas numeradas, como um arquivo. */}
              <ol className="border-b py-5 lg:border-b-0 lg:border-r lg:py-8">
                <Line n={1}>
                  <p className="font-mono text-xs lowercase text-primary">
                    passo {pad(active + 1)} de {pad(STEPS.length)}
                  </p>
                </Line>
                <Line n={2}>
                  <h3 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
                    {step.title}
                  </h3>
                </Line>
                <Line n={3}>
                  <p className="max-w-prose text-base leading-relaxed text-ink-muted">
                    {step.description}
                  </p>
                </Line>
                {step.facts.map(([key, value], i) => (
                  <Line key={key} n={4 + i}>
                    <p className="grid grid-cols-[5.5rem_1fr] font-mono text-sm">
                      <span className="text-primary">{key}</span>
                      <span className="text-ink">{value}</span>
                    </p>
                  </Line>
                ))}
              </ol>

              <div className="overflow-hidden bg-[radial-gradient(70%_80%_at_70%_30%,hsl(var(--primary)/0.14),transparent_70%)] bg-primary/[0.05] p-4 sm:p-6 pin:py-4">
                <p className="mb-2 font-mono text-xs lowercase text-primary">prévia</p>
                {/* `key`: troca de etapa remonta a prévia e reinicia a animação dela. */}
                <div key={active}>{step.preview}</div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-4 border-t px-4 py-3 font-mono text-xs lowercase text-ink-muted sm:px-5">
              <span>
                <span className="text-primary">{pad(active + 1)}</span> / {pad(STEPS.length)}
              </span>
              <span className="hidden pin:inline">
                role para ver o próximo passo ·{' '}
                <a
                  href="#recursos"
                  className={cn('rounded underline underline-offset-4', focusRing)}
                >
                  pular
                </a>
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Linha do extrato: número na calha à esquerda, conteúdo ao lado. */
function Line({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[2.5rem_1fr] gap-x-2 py-1.5 pr-4 sm:grid-cols-[3rem_1fr] sm:pr-6">
      <span
        aria-hidden
        className="select-none pt-0.5 text-right font-mono text-xs tabular-nums text-ink-muted/60"
      >
        {n}
      </span>
      <div className="min-w-0">{children}</div>
    </li>
  );
}
