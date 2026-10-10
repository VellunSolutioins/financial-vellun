import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { container, focusRing } from './styles';

/** Só perguntas com resposta verificável no produto. Preço fica de fora até haver oferta pública. */
const QUESTIONS: { question: string; answer: React.ReactNode }[] = [
  {
    question: 'Como funciona o registro pelo WhatsApp?',
    answer:
      'Depois de verificar seu número, você envia uma mensagem para o WhatsApp do Financial Vellun contando o gasto ou a receita. O lançamento é criado na sua conta e você recebe uma confirmação com valor, categoria e data.',
  },
  {
    question: 'E se a mensagem estiver incompleta?',
    answer:
      'Quando falta uma informação, como o valor ou a conta, perguntamos antes de registrar. Você também pode cancelar nesse momento, e nada é lançado.',
  },
  {
    question: 'Posso corrigir um lançamento depois?',
    answer:
      'Sim. Todos os lançamentos ficam no aplicativo, onde você pode editar ou excluir cada um.',
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

export function Faq() {
  return (
    <section className="bg-surface">
      <div className={cn(container, 'py-14 lg:py-24')}>
        <h2 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
          Perguntas frequentes
        </h2>
        <div className="mt-8 max-w-3xl space-y-3">
          {QUESTIONS.map((item) => (
            <details key={item.question} className="group rounded-2xl border bg-card">
              <summary
                className={cn(
                  'flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-5 py-3 text-base font-semibold text-ink [&::-webkit-details-marker]:hidden',
                  focusRing,
                )}
              >
                {item.question}
                <ChevronDown
                  aria-hidden
                  className="h-5 w-5 shrink-0 text-ink-muted transition-transform group-open:rotate-180 motion-reduce:transition-none"
                />
              </summary>
              <p className="px-5 pb-5 text-base leading-relaxed text-ink-muted">{item.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
