import { ProductDemo } from '@/components/marketing/product-demo';

/**
 * Área de apresentação do login e do cadastro, só a partir do `lg`. Fica presa
 * ao topo enquanto o formulário rola; em janelas baixas, rola por dentro em vez
 * de cortar a demonstração.
 */
export function AuthAside() {
  return (
    <aside className="hidden border-r bg-surface lg:sticky lg:top-0 lg:order-first lg:flex lg:h-screen lg:flex-col lg:justify-center lg:gap-10 lg:overflow-y-auto lg:p-12 lg:supports-[height:100dvh]:h-dvh">
      <div className="mx-auto w-full max-w-md">
        <p className="text-sm font-medium text-primary">Controle financeiro pelo WhatsApp</p>
        <p className="mt-3 text-balance text-3xl font-bold leading-tight tracking-tight text-ink">
          Seu controle financeiro começa com uma mensagem.
        </p>
      </div>
      <ProductDemo />
    </aside>
  );
}
