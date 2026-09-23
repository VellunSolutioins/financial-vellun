/**
 * O Helmet da API protege as respostas dela, não os documentos HTML servidos
 * aqui (plano de segurança, S3). Estes headers valem para todas as páginas.
 *
 * A CSP vai em `Report-Only`: o Next injeta estilos e scripts inline, e uma CSP
 * bloqueante sem `nonce` quebraria a aplicação. Em relatório, dá para medir o
 * que seria bloqueado antes de apertar.
 */
const apiOrigin = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').origin;
  } catch {
    return 'http://localhost:3001';
  }
})();

const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // Inline: exigido pelo runtime do Next (hidratação e estilos das páginas).
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' ${apiOrigin}`,
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy-Report-Only', value: csp },
  // Clickjacking: o app nunca é embutido em outro site.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  // Recursos que o app não usa.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@financial-vellun/shared'],
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

module.exports = nextConfig;
