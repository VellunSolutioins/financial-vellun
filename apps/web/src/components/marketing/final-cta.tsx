import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { container } from './styles';

export function FinalCta() {
  return (
    <section className="bg-primary">
      <div
        className={cn(
          container,
          'flex flex-col gap-6 py-14 lg:flex-row lg:items-center lg:justify-between lg:py-16',
        )}
      >
        <div>
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
          className="shrink-0 bg-background text-primary hover:bg-surface sm:self-start lg:self-center"
        >
          <Link href="/cadastro">Criar minha conta</Link>
        </Button>
      </div>
    </section>
  );
}
