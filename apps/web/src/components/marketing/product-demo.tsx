import { ArrowDown, CheckCheck, ShoppingCart } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  demoCategories,
  demoChat,
  demoEntry,
  formatDemoCurrency,
  formatDemoPercent,
} from './demo-data';

/** Entrada em sequência; com movimento reduzido, tudo já aparece no estado final. */
const stage = 'animate-demo-in motion-reduce:animate-none';

function ChatPanel() {
  return (
    <div className="overflow-hidden rounded-3xl border bg-card shadow-card">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <span
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground"
        >
          FV
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">Financial Vellun</p>
          <p className="text-xs text-ink-muted">Conversa no WhatsApp</p>
        </div>
      </div>
      <div className="space-y-3 bg-surface p-4">
        <div
          className={cn(
            stage,
            'ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-[6px] bg-emerald-100 px-3.5 py-2.5 [animation-delay:150ms]',
          )}
        >
          <p className="text-[15px] leading-snug text-ink">
            <span className="sr-only">Você: </span>
            {demoChat.userMessage}
          </p>
          <p className="mt-1 flex items-center justify-end gap-1 text-xs text-ink-muted">
            {demoChat.time}
            <CheckCheck aria-hidden className="h-3.5 w-3.5 text-primary" />
          </p>
        </div>
        <div
          className={cn(
            stage,
            'mr-auto w-fit max-w-[85%] rounded-2xl rounded-bl-[6px] border bg-card px-3.5 py-2.5 [animation-delay:900ms]',
          )}
        >
          <p className="text-[15px] leading-snug text-ink">
            <span className="sr-only">Financial Vellun: </span>
            {demoChat.botReply}
          </p>
          <p className="mt-1 text-right text-xs text-ink-muted">{demoChat.time}</p>
        </div>
      </div>
    </div>
  );
}

function EntryPanel() {
  return (
    <div
      className={cn(stage, 'rounded-3xl border bg-card p-4 shadow-card [animation-delay:1700ms]')}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-ink">Lançamentos</p>
        <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
          Novo
        </span>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 rounded-2xl bg-surface p-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-card text-ink"
          >
            <ShoppingCart className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink">{demoEntry.description}</p>
            <p className="text-xs text-ink-muted">
              Despesa · {demoEntry.date}
              <span className="hidden min-[360px]:inline"> · {demoEntry.account}</span>
            </p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-semibold tabular-nums text-danger">
            {formatDemoCurrency(-demoEntry.amount)}
          </p>
          <p className="mt-1 inline-flex items-center gap-1.5 rounded-full border bg-card px-2 py-0.5 text-xs text-ink">
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: demoEntry.categoryColor }}
            />
            <span className="sr-only">Categoria: </span>
            {demoEntry.category}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Demonstração "mensagem → confirmação → lançamento". É só HTML e CSS com dados
 * locais (`demo-data.ts`): não chama API nem envia mensagem.
 */
export function ProductDemo({ className }: { className?: string }) {
  return (
    <figure className={cn('mx-auto w-full max-w-md', className)}>
      <ChatPanel />
      <div
        aria-hidden
        className={cn(stage, 'flex justify-center py-2 text-primary [animation-delay:1700ms]')}
      >
        <ArrowDown className="h-5 w-5" />
      </div>
      <EntryPanel />
      <figcaption className="mt-3 text-center text-sm text-ink-muted">
        Demonstração com dados fictícios
      </figcaption>
    </figure>
  );
}

/**
 * Recorte do card "Para onde foi seu dinheiro" do dashboard
 * (`components/dashboard/CategoryBars.tsx`), com dados fictícios.
 */
export function CategoryDemo({ className }: { className?: string }) {
  const total = demoCategories.reduce((sum, c) => sum + c.total, 0);

  return (
    <figure className={cn('w-full', className)}>
      <div className="rounded-3xl border bg-card p-5 shadow-card sm:p-6">
        <p className="text-base font-semibold text-ink">Para onde foi seu dinheiro</p>
        <p className="text-xs text-ink-muted">Gastos do mês</p>
        <div className="mt-4">
          <p className="text-xs text-ink-muted">Total do mês</p>
          <p className="text-xl font-bold tabular-nums text-ink">{formatDemoCurrency(total)}</p>
        </div>
        <ul className="mt-4 space-y-3">
          {demoCategories.map((category) => {
            const share = (category.total / total) * 100;
            return (
              <li key={category.name} className="space-y-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
                  <span className="text-ink">{category.name}</span>
                  <span className="whitespace-nowrap font-medium tabular-nums text-ink-muted">
                    {formatDemoCurrency(category.total)} · {formatDemoPercent(share)}
                  </span>
                </div>
                <div aria-hidden className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${share}%`, backgroundColor: category.color }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <figcaption className="mt-3 text-center text-sm text-ink-muted">
        Demonstração com dados fictícios
      </figcaption>
    </figure>
  );
}
