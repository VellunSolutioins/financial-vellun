import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { AuthProvider } from '@/contexts/auth-context';
import { ToastProvider } from '@/components/ui/toast';
import { ConfirmProvider } from '@/components/ui/confirm';
import { THEME_INIT_SCRIPT } from '@/lib/public-theme';
import './globals.css';

// Itálico: as frases de destaque dos títulos das páginas públicas.
const inter = Inter({ subsets: ['latin'], style: ['normal', 'italic'] });
// Rótulos e números "de extrato" das páginas públicas (`font-mono`).
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  // Base dos links absolutos (prévia ao compartilhar, canonical). Previews e
  // ambiente local podem trocar com NEXT_PUBLIC_SITE_URL.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://zeloo.app.br'),
  title: 'Zeloo',
  applicationName: 'Zeloo',
  description: 'Controle financeiro pessoal e empresarial',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `data-scroll-behavior`: o Next desliga a rolagem suave (ligada nas páginas
    // públicas, ver globals.css) durante a troca de rota.
    // `suppressHydrationWarning`: o script abaixo põe `data-theme` antes do React.
    // `data-palette="verde"`: teste do verde #10B981 como cor primária (globals.css).
    // Tirar o atributo volta para o azul.
    <html lang="pt-BR" data-palette="verde" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        {/* Tema das páginas públicas aplicado antes da primeira pintura. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className={`${inter.className} ${mono.variable}`}>
        <ToastProvider>
          <ConfirmProvider>
            <AuthProvider>{children}</AuthProvider>
          </ConfirmProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
