const allowedOrigins = [
  process.env.WEB_URL,
  ...(process.env.WEB_ALLOWED_ORIGINS?.split(',') ?? []),
  'http://localhost:3000',
  'https://financial-vellun-web.vercel.app',
]
  .filter(Boolean)
  .map((origin) => normalizeOrigin(origin!.trim()))
  .filter(Boolean);

export function normalizeOrigin(origin: string): string {
  return origin.replace(/\/$/, '');
}

export function isAllowedWebOrigin(origin?: string): boolean {
  if (!origin) return false;

  const normalizedOrigin = normalizeOrigin(origin);
  return (
    allowedOrigins.includes(normalizedOrigin) ||
    /^https:\/\/financial-vellun-web-git-[a-z0-9-]+-vellun-s-projects\.vercel\.app$/.test(
      normalizedOrigin,
    )
  );
}
