'use client';
import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import { focusRing } from './styles';

interface MobileMenuProps {
  links: { href: string; label: string }[];
}

/**
 * Menu das telas pequenas. O painel abre logo abaixo do cabeçalho (que é o
 * ancestral posicionado). Ao abrir, o foco vai ao primeiro link; Escape fecha e
 * devolve o foco ao botão; sair do menu por toque ou Tab também fecha.
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
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
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
                onClick={() => setOpen(false)}
                className={`flex min-h-12 items-center rounded-lg px-2 text-base font-medium text-ink hover:bg-surface ${focusRing}`}
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
