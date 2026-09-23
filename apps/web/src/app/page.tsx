import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-white">
      {/* Header */}
      <header className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <span className="text-xl font-bold text-primary">Financial Vellun</span>
          <div className="flex gap-3">
            <Button variant="ghost" asChild>
              <Link href="/login">Entrar</Link>
            </Button>
            <Button asChild>
              <Link href="/cadastro">Criar conta</Link>
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-4 py-24 text-center">
        <h1 className="text-5xl font-bold text-gray-900 mb-6">
          Controle financeiro <span className="text-primary">simples e poderoso</span>
        </h1>
        <p className="text-xl text-gray-600 mb-10 max-w-2xl mx-auto">
          Gerencie suas finanças pessoais ou empresariais com inteligência artificial. Lance gastos
          via WhatsApp e tenha tudo organizado automaticamente.
        </p>
        <div className="flex gap-4 justify-center">
          <Button size="lg" asChild>
            <Link href="/cadastro">Começar gratuitamente</Link>
          </Button>
          <Button size="lg" variant="outline" asChild>
            <Link href="/login">Já tenho conta</Link>
          </Button>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-6xl mx-auto px-4 py-20">
        <h2 className="text-3xl font-bold text-center text-gray-900 mb-12">Funcionalidades</h2>
        <div className="grid md:grid-cols-3 gap-8">
          {[
            {
              icon: '👤',
              title: 'Controle Pessoal',
              desc: 'Acompanhe receitas, despesas e saldo das suas contas pessoais em tempo real.',
            },
            {
              icon: '🏢',
              title: 'Gestão Empresarial',
              desc: 'Fluxo de caixa, contas a pagar e receber, categorias empresariais e muito mais.',
            },
            {
              icon: '💬',
              title: 'Lançamentos via WhatsApp',
              desc: 'Envie uma mensagem e nossa IA registra automaticamente o lançamento para você.',
            },
          ].map((f) => (
            <div
              key={f.title}
              className="rounded-xl border bg-white p-8 shadow-sm hover:shadow-md transition-shadow"
            >
              <div className="text-4xl mb-4">{f.icon}</div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">{f.title}</h3>
              <p className="text-gray-600">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t bg-white mt-20">
        <div className="max-w-6xl mx-auto px-4 py-8 text-center text-sm text-gray-500">
          © {new Date().getFullYear()} Financial Vellun. Todos os direitos reservados.
        </div>
      </footer>
    </div>
  );
}
