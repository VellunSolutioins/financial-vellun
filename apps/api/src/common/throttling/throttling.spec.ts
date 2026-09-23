import { JwtService } from '@nestjs/jwt';

import { verifiedSubject } from './app-throttler.guard';
import { ResilientThrottlerStorage } from './resilient-throttler.storage';

const SECRET = 'x'.repeat(32);
const jwt = new JwtService({});

describe('verifiedSubject', () => {
  it('devolve o usuário de um token válido', async () => {
    const token = await jwt.signAsync({ sub: 'user-1' }, { secret: SECRET, expiresIn: 60 });
    expect(verifiedSubject(token, SECRET)).toBe('user-1');
  });

  it('recusa token assinado com outro segredo', async () => {
    // Sem verificar, qualquer um trocaria de `sub` a cada requisição para
    // escapar do limite, ou gastaria o limite de outra pessoa.
    const token = await jwt.signAsync({ sub: 'user-1' }, { secret: 'y'.repeat(32) });
    expect(verifiedSubject(token, SECRET)).toBeNull();
  });

  it('recusa token expirado', async () => {
    const token = await jwt.signAsync(
      { sub: 'user-1', exp: Math.floor(Date.now() / 1000) - 10 },
      { secret: SECRET },
    );
    expect(verifiedSubject(token, SECRET)).toBeNull();
  });

  it('recusa token sem assinatura (alg none)', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64url');
    expect(verifiedSubject(`${header}.${payload}.`, SECRET)).toBeNull();
  });

  it('ignora cookie ausente ou malformado', () => {
    expect(verifiedSubject(undefined, SECRET)).toBeNull();
    expect(verifiedSubject('lixo', SECRET)).toBeNull();
  });
});

describe('ResilientThrottlerStorage', () => {
  const record = { totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 };

  it('conta no Redis quando ele responde', async () => {
    const primary = { increment: jest.fn().mockResolvedValue(record) };
    const storage = new ResilientThrottlerStorage(primary);

    await expect(storage.increment('k', 60_000, 10, 60_000, 'default')).resolves.toBe(record);
    expect(primary.increment).toHaveBeenCalledWith('k', 60_000, 10, 60_000, 'default');
  });

  it('com o Redis fora, conta em memória em vez de derrubar a requisição', async () => {
    const primary = { increment: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    const storage = new ResilientThrottlerStorage(primary);

    const first = await storage.increment('k', 60_000, 2, 60_000, 'default');
    const second = await storage.increment('k', 60_000, 2, 60_000, 'default');
    const third = await storage.increment('k', 60_000, 2, 60_000, 'default');

    expect([first.totalHits, second.totalHits]).toEqual([1, 2]);
    // O limite continua valendo no modo degradado.
    expect(third.isBlocked).toBe(true);
  });

  it('sem Redis configurado, conta em memória', async () => {
    const storage = new ResilientThrottlerStorage(null);
    const result = await storage.increment('k', 60_000, 10, 60_000, 'default');
    expect(result.totalHits).toBe(1);
  });
});
