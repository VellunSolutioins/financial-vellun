import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Reveal } from './reveal';
import { container } from './styles';

/** `v1`: azul sólido (servido em `/`); `v2`: azul com gradiente (servido em `/v2`). */
export function FinalCta({ variant = 'v2' }: { variant?: 'v1' | 'v2' }) {
  return (
    <section className={variant === 'v1' ? 'bg-primary' : 'bg-glow-primary'}>
      <Reveal
        className={cn(
          container,
          'flex flex-col gap-6 py-14 lg:flex-row lg:items-center lg:justify-between lg:py-16',
        )}
      >
        <div className="reveal">
          <h2 className="max-w-2xl text-balance text-3xl font-bold tracking-tight text-primary-foreground sm:text-4xl">
            Organize suas finanças a partir da próxima mensagem.
          </h2>
          <p className="mt-3 text-lg text-primary-foreground">
            Crie sua conta e verifique seu WhatsApp para começar.
          </p>
        </div>
        <Button
          size="xl"
          asChild
          className="reveal shrink-0 bg-background text-primary hover:bg-surface sm:self-start lg:self-center"
        >
          <Link href="/cadastro">Criar minha conta</Link>
        </Button>
      </Reveal>
    </section>
  );
}
