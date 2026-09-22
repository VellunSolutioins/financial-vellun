/** Forma canônica do e-mail: sem espaços nas pontas e em minúsculas. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
