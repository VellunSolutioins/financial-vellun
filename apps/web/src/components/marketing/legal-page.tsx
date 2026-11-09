import Link from 'next/link';
import { cn } from '@/lib/utils';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';
import { container, textLink } from './styles';

export interface LegalSection {
  title: string;
  paragraphs: string[];
}

interface LegalPageProps {
  title: string;
  /** Data por extenso, ex.: "10 de outubro de 2026". */
  updatedAt: string;
  sections: LegalSection[];
}

/** Estrutura comum de Política de Privacidade e Termos de Serviço. */
export function LegalPage({ title, updatedAt, sections }: LegalPageProps) {
  return (
    <div className="bg-background text-ink">
      <SiteHeader />
      <main className={cn(container, 'py-10 sm:py-16')}>
        <article className="mx-auto max-w-[720px]">
          <h1 className="text-balance text-[clamp(2rem,1.5rem+2.2vw,3rem)] font-bold leading-tight tracking-tight">
            {title}
          </h1>
          <p className="mt-3 text-sm text-ink-muted">Última atualização: {updatedAt}</p>

          {sections.map((section, index) => (
            <section key={section.title} className="mt-10">
              <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
                {index + 1}. {section.title}
              </h2>
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph} className="mt-3 text-base leading-relaxed text-ink-muted">
                  {paragraph}
                </p>
              ))}
            </section>
          ))}

          <p className="mt-10">
            <Link href="/" className={cn(textLink, '-ml-1')}>
              Voltar para a página inicial
            </Link>
          </p>
        </article>
      </main>
      <SiteFooter />
    </div>
  );
}
