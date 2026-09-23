import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** SHA-256 em hex. Para tokens aleatórios de alta entropia, não para senhas. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Token opaco aleatório (256 bits), em base64url. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Código numérico de `length` dígitos, com zeros à esquerda (ex.: `048213`). */
export function randomNumericCode(length = 6): string {
  return randomInt(0, 10 ** length)
    .toString()
    .padStart(length, '0');
}

/** Compara duas strings em tempo constante; tamanhos diferentes são falso. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
