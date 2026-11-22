'use client';
import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { focusRing } from './styles';

interface MobileMenuProps {
  links: { href: string; label: string; current?: boolean }[];
}

/** Rolagem (em px) que fecha o menu: o painel não fica solto sobre o conteúdo. */
const CLOSE_ON_SCROLL_PX = 24;

/**
 * Menu das telas pequenas. O painel abre logo abaixo do cabeçalho (que é o
 * ancestral posicionado), sobre um fundo escurecido. Ao abrir, o foco vai ao
 * primeiro link; Escape fecha e devolve o foco ao botão; tocar fora, sair do
 * menu por Tab ou rolar a página também fecha.
 */
export function MobileMenu({ links }: MobileMenuProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('a')?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const startY = window.scrollY;
    const onScroll = () => {
      if (Math.abs(window.scrollY - startY) > CLOSE_ON_SCROLL_PX) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll);
    };
  }, [open]);

  return (
    <div
      className="md:hidden"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? 'Fechar menu' : 'Abrir menu'}
        // Sem isto, no Safari o toque tira o foco do link, o `onBlur` fecha o
        // menu e o clique o reabre.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className={`-mr-2 inline-flex h-11 w-11 items-center justify-center rounded-lg text-ink hover:bg-surface ${focusRing}`}
      >
        {open ? <X aria-hidden className="h-5 w-5" /> : <Menu aria-hidden className="h-5 w-5" />}
      </button>
      {/* Fundo: separa o menu do conteúdo e fecha ao tocar fora. */}
      {open && (
        <div
          aria-hidden
          onClick={() => setOpen(false)}
          className="absolute inset-x-0 top-full h-[100dvh] bg-ink/30"
        />
      )}
      <nav
        ref={panelRef}
        id={panelId}
        aria-label="Menu"
        hidden={!open}
        className="absolute inset-x-0 top-full border-b bg-background shadow-soft"
      >
        <ul className="px-4 py-2">
          {links.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={link.current ? 'location' : undefined}
                onClick={() => setOpen(false)}
                className={cn(
                  'flex min-h-12 items-center rounded-lg px-2 text-base font-medium text-ink hover:bg-surface',
                  link.current && 'bg-surface text-primary',
                  focusRing,
                )}
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
