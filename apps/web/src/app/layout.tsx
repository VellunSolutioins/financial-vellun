import type { Metadata } from 'next';
import { Instrument_Sans, JetBrains_Mono } from 'next/font/google';
import { AuthProvider } from '@/contexts/auth-context';
import { ToastProvider } from '@/components/ui/toast';
import { ConfirmProvider } from '@/components/ui/confirm';
import { THEME_INIT_SCRIPT } from '@/lib/public-theme';
import './globals.css';

// Instrument Sans (em teste; antes era Inter): grotesca mais estreita e de
// desenho mais editorial, combina com os cards de vidro e o 3D do hero. Para
// voltar, troque por `Inter` com os mesmos parâmetros.
// Itálico: as frases de destaque dos títulos das páginas públicas.
const sans = Instrument_Sans({ subsets: ['latin'], style: ['normal', 'italic'] });
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
    // Primária azul da marca. O verde fica nos degradês e em detalhes; a paleta
    // `data-palette="verde"` (globals.css) segue disponível para testes.
    <html lang="pt-BR" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        {/* Tema das páginas públicas aplicado antes da primeira pintura. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className={`${sans.className} ${mono.variable}`}>
        <ToastProvider>
          <ConfirmProvider>
            <AuthProvider>{children}</AuthProvider>
          </ConfirmProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
