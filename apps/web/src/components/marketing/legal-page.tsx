import Link from 'next/link';
import { cn } from '@/lib/utils';
import { MAIN_CONTENT_ID } from './sections';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';
import { container, focusRing, textLink } from './styles';

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

/** "5. Direitos do titular" → `direitos-do-titular`: âncora estável para citar a seção. */
function sectionId(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Estrutura comum de Política de Privacidade e Termos de Serviço. O sumário no
 * topo leva a cada seção, e cada seção tem âncora própria para ser citada em
 * links (ex.: `/privacidade#direitos-do-titular`).
 */
export function LegalPage({ title, updatedAt, sections }: LegalPageProps) {
  return (
    <div data-public-page className="bg-glow-page text-ink">
      <SiteHeader />
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className={cn(container, 'py-10 focus:outline-none sm:py-16')}
      >
        <article className="mx-auto max-w-[720px]">
          <h1 className="text-balance text-[clamp(2rem,1.5rem+2.2vw,3rem)] font-bold leading-tight tracking-tight">
            {title}
          </h1>
          <p className="mt-3 text-sm text-ink-muted">Última atualização: {updatedAt}</p>

          <nav aria-label="Nesta página" className="mt-8 rounded-2xl bg-surface p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-ink">Nesta página</h2>
            <ol className="-ml-2 mt-2 grid gap-x-6 sm:grid-cols-2">
              {sections.map((section, index) => (
                <li key={section.title}>
                  <a
                    href={`#${sectionId(section.title)}`}
                    className={cn(
                      'flex min-h-11 items-center rounded-lg px-2 text-sm text-ink-muted hover:text-ink',
                      focusRing,
                    )}
                  >
                    {index + 1}. {section.title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          {sections.map((section, index) => (
            <section key={section.title} id={sectionId(section.title)} className="mt-10">
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
