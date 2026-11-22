import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import type { FeatureFlags } from '@/lib/features';
import { getPublicFeatures } from '@/lib/public-features';
import { cn } from '@/lib/utils';
import { Eyebrow } from './eyebrow';
import { Reveal } from './reveal';
import { container, focusRing } from './styles';

type Answer = React.ReactNode | ((features: FeatureFlags) => React.ReactNode);

/**
 * Só perguntas com resposta verificável no produto. Preço fica de fora até haver
 * oferta pública. Respostas que dependem de uma funcionalidade com flag recebem
 * as flags e descrevem só o que está ligado.
 */
const QUESTIONS: { question: string; answer: Answer }[] = [
  {
    question: 'Como funciona o registro pelo WhatsApp?',
    answer:
      'Depois de verificar seu número, você envia uma mensagem para o WhatsApp do Zeloo contando o gasto ou a receita. O lançamento é criado na sua conta e você recebe uma confirmação com valor, categoria e data.',
  },
  {
    question: 'E se a mensagem estiver incompleta?',
    answer:
      'Quando falta uma informação, como o valor ou a conta, perguntamos antes de registrar. Você também pode cancelar nesse momento, e nada é lançado.',
  },
  {
    question: 'Posso corrigir um lançamento depois?',
    answer: (features) =>
      features.whatsapp_edit
        ? 'Sim. Pelo WhatsApp, é só pedir, como "corrige o mercado de ontem, foi 45" ou "apaga o último". Mostramos o que vai mudar e só alteramos depois do seu "sim". No aplicativo, você também pode editar ou excluir qualquer lançamento.'
        : 'Sim. Todos os lançamentos ficam no aplicativo, onde você pode editar ou excluir cada um.',
  },
  {
    question: 'Outra pessoa pode lançar na minha conta?',
    answer:
      'Não. Só registramos mensagens enviadas pelo número de WhatsApp que você verificou na sua conta.',
  },
  {
    question: 'Como meus dados são tratados?',
    answer: (
      <>
        Usamos os seus dados para manter a sua conta e registrar os seus lançamentos, e não vendemos
        dados pessoais. Os detalhes estão na{' '}
        <Link
          href="/privacidade"
          className={cn(
            'rounded font-medium text-primary underline underline-offset-4 hover:text-primary-hover',
            focusRing,
          )}
        >
          Política de Privacidade
        </Link>
        .
      </>
    ),
  },
];

/**
 * `v1`: visual de antes do redesenho (servido em `/`); `v2`: rótulo de extrato,
 * perguntas numeradas e fundo com gradiente (servido em `/v2`).
 */
export async function Faq({ variant = 'v2' }: { variant?: 'v1' | 'v2' }) {
  const v1 = variant === 'v1';
  const features = await getPublicFeatures();

  return (
    <section id="duvidas" className={v1 ? 'bg-surface' : 'bg-glow-surface'}>
      <Reveal className={cn(container, 'py-14 lg:py-24')}>
        {v1 ? (
          <h2 className="reveal text-3xl font-bold tracking-tight text-ink sm:text-4xl">
            Perguntas frequentes
          </h2>
        ) : (
          <div className="reveal">
            <Eyebrow number="03">dúvidas</Eyebrow>
            <h2 className="mt-3 text-3xl font-medium tracking-tight text-ink sm:text-4xl">
              Perguntas <em className="font-bold italic">frequentes.</em>
            </h2>
          </div>
        )}
        <div className="mt-8 max-w-3xl space-y-3">
          {QUESTIONS.map((item, index) => (
            <details key={item.question} className="reveal group rounded-2xl border bg-card">
              <summary
                className={cn(
                  'flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-5 py-3 text-base font-semibold text-ink [&::-webkit-details-marker]:hidden',
                  focusRing,
                )}
              >
                <span className="flex gap-3">
                  {!v1 && (
                    <span aria-hidden className="pt-0.5 font-mono text-xs text-primary">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                  )}
                  {item.question}
                </span>
                <ChevronDown
                  aria-hidden
                  className="h-5 w-5 shrink-0 text-ink-muted transition-transform group-open:rotate-180 motion-reduce:transition-none"
                />
              </summary>
              <p className="px-5 pb-5 text-base leading-relaxed text-ink-muted">
                {typeof item.answer === 'function' ? item.answer(features) : item.answer}
              </p>
            </details>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
