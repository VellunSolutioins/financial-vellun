import { HealthCheckError } from '@nestjs/terminus';

import { HealthController } from './health.controller';
import { PrismaHealthIndicator } from './prisma.health-indicator';
import { RedisHealthIndicator } from './redis.health-indicator';

/**
 * Critério de aceite do plano: *readiness refletindo dependência caída, sem
 * derrubar liveness*.
 *
 * A distinção é a razão de os dois endpoints existirem. Liveness responde "este
 * processo precisa ser reiniciado?"; se ele caísse junto com o Postgres, o
 * orquestrador reiniciaria a API em loop enquanto o problema está no banco — e
 * o restart não conserta nada. Readiness responde "posso receber tráfego?", e aí
 * depender do banco é o certo.
 */
describe('liveness e readiness', () => {
  describe('PrismaHealthIndicator', () => {
    it('faz uma consulta de verdade, não checa se o cliente existe', async () => {
      const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) } as any;

      const resultado = await new PrismaHealthIndicator(prisma).check();

      // O `GET /` anterior respondia `ok` com o banco fora — o pior desfecho
      // possível, porque mantinha no balanceador uma instância inútil.
      expect(prisma.$queryRaw).toHaveBeenCalled();
      expect(resultado).toEqual({ database: { status: 'up' } });
    });

    it('banco fora derruba o readiness', async () => {
      const prisma = { $queryRaw: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) } as any;

      await expect(new PrismaHealthIndicator(prisma).check()).rejects.toBeInstanceOf(
        HealthCheckError,
      );
    });

    it('não vaza a mensagem do driver, que pode carregar credencial', async () => {
      // Montado em tempo de execução: uma string de conexão literal no código
      // seria exatamente o que o próprio indicador existe para não vazar.
      const credencial = ['usuario', 'senha-do-banco'].join(':');
      const erro = new Error(`connect ECONNREFUSED para ${credencial}@host:5432`);
      erro.name = 'PrismaClientInitializationError';
      const prisma = { $queryRaw: jest.fn().mockRejectedValue(erro) } as any;

      const capturado = await new PrismaHealthIndicator(prisma)
        .check()
        .catch((e: HealthCheckError) => e);

      const serializado = JSON.stringify((capturado as HealthCheckError).causes);
      // Só o tipo do erro sai; o resto fica no log, não na resposta pública.
      expect(serializado).toContain('PrismaClientInitializationError');
      expect(serializado).not.toContain('senha-do-banco');
    });

    it('banco que aceita e não responde não pendura o readiness', async () => {
      jest.useFakeTimers();
      // Um Postgres saturado não recusa conexão: ele aceita e fica calado. Sem
      // teto, o readiness ficaria pendurado junto e o balanceador não tiraria a
      // instância do ar.
      const prisma = { $queryRaw: jest.fn().mockReturnValue(new Promise(() => {})) } as any;

      const promessa = new PrismaHealthIndicator(prisma).check().catch((e) => e);
      await jest.advanceTimersByTimeAsync(2_500);

      expect(await promessa).toBeInstanceOf(HealthCheckError);
      jest.useRealTimers();
    });
  });

  describe('RedisHealthIndicator', () => {
    const indicador = (client: unknown) => new RedisHealthIndicator({ client } as any);

    it('sem REDIS_URL, reporta `disabled` em vez de falhar', async () => {
      expect(await indicador(null).check()).toEqual({
        redis: { status: 'up', state: 'disabled' },
      });
    });

    it('Redis no ar responde `up`', async () => {
      const client = { ping: jest.fn().mockResolvedValue('PONG') };

      expect(await indicador(client).check()).toEqual({
        redis: { status: 'up', state: 'up' },
      });
      expect(client.ping).toHaveBeenCalled();
    });

    it('Redis fora vira `degraded`, e não 503', async () => {
      // Todas as réplicas olham o mesmo Redis: falhar aqui tiraria todas do
      // balanceador de uma vez, trocando uma degradação planejada (rate limit
      // em memória) por um apagão.
      const erro = new Error('connect ECONNREFUSED redis://:senha-do-redis@host:6379');
      erro.name = 'ReplyError';
      const client = { ping: jest.fn().mockRejectedValue(erro) };

      const resultado = await indicador(client).check();

      expect(resultado.redis.status).toBe('up');
      expect(resultado.redis.state).toBe('degraded');
      // Só o tipo do erro sai: a mensagem do driver carrega a senha da URL.
      expect(JSON.stringify(resultado)).not.toContain('senha-do-redis');
    });

    it('Redis que aceita e não responde não pendura o readiness', async () => {
      jest.useFakeTimers();
      const client = { ping: jest.fn().mockReturnValue(new Promise(() => {})) };

      const promessa = indicador(client).check();
      await jest.advanceTimersByTimeAsync(2_500);

      expect((await promessa).redis.state).toBe('degraded');
      jest.useRealTimers();
    });
  });

  describe('HealthController', () => {
    const redisOk = () =>
      ({ check: jest.fn().mockResolvedValue({ redis: { status: 'up', state: 'up' } }) }) as any;

    it('liveness não depende de nada externo', () => {
      const prisma = { check: jest.fn().mockRejectedValue(new Error('banco fora')) } as any;
      const redis = redisOk();
      const health = { check: jest.fn() } as any;

      const controller = new HealthController(health, prisma, redis);

      // Com o banco fora, liveness continua 200: reiniciar o processo não
      // consertaria o Postgres.
      expect(controller.liveness()).toEqual({ status: 'ok' });
      expect(prisma.check).not.toHaveBeenCalled();
      expect(redis.check).not.toHaveBeenCalled();
      expect(health.check).not.toHaveBeenCalled();
    });

    it('readiness consulta Postgres e Redis, e só eles', async () => {
      const prisma = { check: jest.fn().mockResolvedValue({ database: { status: 'up' } }) } as any;
      const redis = redisOk();
      const health = {
        check: jest.fn(async (indicadores: (() => Promise<unknown>)[]) => {
          for (const indicador of indicadores) await indicador();
          return { status: 'ok' };
        }),
      } as any;

      await new HealthController(health, prisma, redis).readiness();

      // A API não fala com RabbitMQ, e depender do agente seria errado: a API
      // funciona sem ele.
      expect(prisma.check).toHaveBeenCalledWith('database');
      expect(redis.check).toHaveBeenCalledWith('redis');
      expect(health.check.mock.calls[0][0]).toHaveLength(2);
    });
  });
});
