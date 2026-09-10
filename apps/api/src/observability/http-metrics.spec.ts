import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request } from 'express';

import { elapsedSeconds, routeLabel, statusFromException } from './http-metrics';
import { UNMATCHED_ROUTE } from './metrics.service';

function request(overrides: Partial<Request> = {}): Request {
  return { method: 'GET', path: '/x', ...overrides } as Request;
}

describe('routeLabel', () => {
  it('usa o padrão da rota, não o path concreto', () => {
    // `/transactions/<uuid>` como label criaria uma série por lançamento.
    const req = request({
      path: '/transactions/9f1c2b7e-0000-4444-8888-aaaabbbbcccc',
      route: { path: '/transactions/:id' },
    } as Partial<Request>);

    expect(routeLabel(req)).toBe('/transactions/:id');
  });

  it('agrupa rota inexistente em um único rótulo', () => {
    // Uma varredura de vulnerabilidade não deve virar milhares de séries.
    expect(routeLabel(request({ path: '/wp-admin/setup.php' }))).toBe(UNMATCHED_ROUTE);
    expect(routeLabel(request({ path: '/.env' }))).toBe(UNMATCHED_ROUTE);
  });
});

describe('statusFromException', () => {
  it('extrai o status da HttpException', () => {
    // O caso que motivou este helper: o readiness devolvendo 503 era
    // contabilizado como 200, porque o interceptor roda antes do filtro.
    expect(statusFromException(new ServiceUnavailableException())).toBe(503);
    expect(statusFromException(new ForbiddenException())).toBe(403);
    expect(statusFromException(new BadRequestException())).toBe(400);
  });

  it('traduz violação de unique do Prisma em 409, não em 500', () => {
    // Devolver 500 mandaria o cliente retentar em vão.
    const erro = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: '5.22.0',
    });

    expect(statusFromException(erro)).toBe(409);
  });

  it('traduz registro não encontrado em 404', () => {
    const erro = new Prisma.PrismaClientKnownRequestError('not found', {
      code: 'P2025',
      clientVersion: '5.22.0',
    });

    expect(statusFromException(erro)).toBe(404);
  });

  it('cai em 500 para o que não é previsto', () => {
    expect(statusFromException(new Error('boom'))).toBe(500);
    expect(statusFromException('string solta')).toBe(500);
  });
});

describe('elapsedSeconds', () => {
  it('mede a partir da marcação do middleware', () => {
    const req = request({ startedAt: process.hrtime.bigint() } as Partial<Request>);

    const elapsed = elapsedSeconds(req);
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(1);
  });

  it('devolve 0 quando a marcação não aconteceu', () => {
    // Erro antes do middleware de correlação: sem duração, mas ainda contável.
    expect(elapsedSeconds(request())).toBe(0);
  });
});
