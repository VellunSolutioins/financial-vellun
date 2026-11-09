/** Classes compartilhadas pelas páginas públicas (landing, login, cadastro). */

/** Container fluido: 16 px no mobile, 24–32 px a partir do tablet, máx. 1200 px. */
export const container = 'mx-auto w-full max-w-[1200px] px-4 sm:px-6 lg:px-8';

export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/** Link de texto solto (fora de parágrafo), com área de toque de 44 px. */
export const textLink = `inline-flex min-h-11 items-center rounded-lg px-1 font-medium text-primary underline underline-offset-4 hover:text-primary-hover ${focusRing}`;
