import { REDACTED, maskEmail, maskPhone, sanitizeForLog } from './sanitize';

describe('sanitizeForLog', () => {
  it('redige chaves sensíveis em qualquer profundidade', () => {
    const result = sanitizeForLog({
      user: { name: 'Bruno', passwordHash: '$2a$10$abc', nested: { apiKey: 'sk-123' } },
      authorization: 'Bearer xyz',
    }) as any;

    expect(result.user.passwordHash).toBe(REDACTED);
    expect(result.user.nested.apiKey).toBe(REDACTED);
    expect(result.authorization).toBe(REDACTED);
    // O que não é sensível continua legível — sanitizar tudo inutilizaria o log.
    expect(result.user.name).toBe('Bruno');
  });

  it('mascara identificador pessoal em vez de redigir', () => {
    // Redigir telefone inteiro tornaria impossível reconhecer o número numa
    // investigação; mascarar preserva o suficiente sem registrar o dado.
    const result = sanitizeForLog({
      phone: '+5541999998877',
      email: 'cliente@example.com',
      cpf: '12345678901',
    }) as any;

    expect(result.phone).not.toContain('99999');
    // Sobram DDI+DDD e os dois últimos dígitos; o miolo vira asterisco.
    expect(result.phone).toMatch(/^5541\*+77$/);
    expect(result.email).toBe('c******@example.com');
    expect(result.cpf).not.toBe('12345678901');
  });

  it('preserva arrays e datas', () => {
    const date = new Date('2026-09-09T12:00:00.000Z');
    const result = sanitizeForLog({ items: [{ token: 'a' }, { ok: 1 }], date }) as any;

    expect(result.items[0].token).toBe(REDACTED);
    expect(result.items[1].ok).toBe(1);
    expect(result.date).toBe('2026-09-09T12:00:00.000Z');
  });

  it('não muta o objeto original', () => {
    // O payload sanitizado costuma ser o mesmo que a aplicação ainda vai usar.
    const original = { token: 'segredo', keep: 'ok' };
    sanitizeForLog(original);

    expect(original.token).toBe('segredo');
  });

  it('trunca em vez de estourar a pilha com estrutura muito funda', () => {
    let deep: any = { fim: true };
    for (let i = 0; i < 20; i++) deep = { nested: deep };

    expect(() => sanitizeForLog(deep)).not.toThrow();
    expect(JSON.stringify(sanitizeForLog(deep))).toContain('[TRUNCATED]');
  });
});

describe('maskPhone', () => {
  it('preserva DDI/DDD e os dois últimos dígitos', () => {
    expect(maskPhone('+5541999998877')).toBe('5541*******77');
  });

  it('redige o que é curto demais para mascarar com segurança', () => {
    expect(maskPhone('1234')).toBe(REDACTED);
  });

  it('não revela um número curto que a máscara mostraria inteiro', () => {
    expect(maskPhone('123456')).toBe(REDACTED);
    expect(maskPhone('123456789')).toBe(REDACTED);
    expect(maskPhone('4199998877')).toBe('4199****77');
  });
});

describe('maskEmail', () => {
  it('preserva o domínio', () => {
    expect(maskEmail('bruno@vellun.com')).toBe('b****@vellun.com');
  });

  it('redige o que não é e-mail', () => {
    expect(maskEmail('sem-arroba')).toBe(REDACTED);
    expect(maskEmail('@sem-local')).toBe(REDACTED);
  });
});
