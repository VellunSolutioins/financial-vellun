import type { MetadataRoute } from 'next';

/** Nome e ícones usados quando o site é adicionado à tela inicial (Android/Chrome). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Zeloo',
    short_name: 'Zeloo',
    description: 'Controle financeiro pessoal e empresarial',
    // `/app` não tem página própria e o painel depende do tipo de perfil.
    start_url: '/',
    display: 'standalone',
    background_color: '#FFFFFF',
    theme_color: '#2563EB',
    icons: [
      { src: '/marca/zeloo-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/marca/zeloo-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
