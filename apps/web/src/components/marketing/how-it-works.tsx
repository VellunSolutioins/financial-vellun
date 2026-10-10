import { cn } from '@/lib/utils';
import { container } from './styles';

const STEPS = [
  {
    title: 'Conecte seu WhatsApp',
    description:
      'Crie sua conta e confirme seu número enviando um código para o nosso WhatsApp. É assim que reconhecemos as suas mensagens.',
  },
  {
    title: 'Envie seus lançamentos',
    description:
      'Escreva como você fala: “gastei 100 no mercado” ou “recebi 5000 de salário”. Se faltar alguma informação, perguntamos antes de registrar.',
  },
  {
    title: 'Acompanhe suas finanças',
    description:
      'Cada lançamento aparece no aplicativo, organizado por categoria, junto com o painel do seu mês.',
  },
];

export function HowItWorks() {
  return (
    <section id="como-funciona" className="scroll-mt-16 bg-surface">
      <div className={cn(container, 'py-14 lg:py-24')}>
        <h2 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">Como funciona</h2>
        <p className="mt-3 max-w-2xl text-lg leading-relaxed text-ink-muted">
          Três passos entre a sua mensagem e o seu painel.
        </p>
        <ol className="mt-8 grid gap-4 md:grid-cols-3 md:gap-6 lg:mt-12">
          {STEPS.map((step, index) => (
            <li
              key={step.title}
              className="flex gap-4 rounded-3xl border bg-card p-5 shadow-soft md:flex-col md:p-6"
            >
              <span
                aria-hidden
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-base font-bold text-primary-foreground"
              >
                {index + 1}
              </span>
              <div>
                <h3 className="text-lg font-semibold text-ink">{step.title}</h3>
                <p className="mt-2 text-base leading-relaxed text-ink-muted">{step.description}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
