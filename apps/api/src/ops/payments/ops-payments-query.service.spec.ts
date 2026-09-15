import { NotFoundException } from '@nestjs/common';
import { OpsRole, WebhookEventStatus } from '@prisma/client';

import { OPS_AUDIT_ACTIONS, OPS_AUDIT_TARGETS } from '../ops.constants';
import { OpsPaymentsQueryService } from './ops-payments-query.service';

const linha = {
  id: 'evt-1',
  providerEventId: 'evt_asaas_1',
  eventType: 'PAYMENT_RECEIVED',
  status: WebhookEventStatus.failed,
  attempts: 3,
  receivedAt: new Date('2026-09-09T08:00:00.000Z'),
  processedAt: null,
  lastError: 'timeout ao consultar assinatura',
  sanitizedPayload: {
    event: 'PAYMENT_RECEIVED',
    customer: { name: 'Bruno Faboci', email: 'bruno@vellun.com.br' },
  },
  createdAt: new Date('2026-09-09T08:00:00.000Z'),
  updatedAt: new Date('2026-09-09T08:05:00.000Z'),
};

const semPermissao = {
  id: 'op-1',
  githubLogin: 'operador',
  role: OpsRole.operator,
  canViewSensitive: false,
};

const comPermissao = {
  id: 'op-2',
  githubLogin: 'investigador',
  role: OpsRole.operator,
  canViewSensitive: true,
};

/** Projeta a linha conforme o `select`, como o Prisma faria. */
function projetar(select: Record<string, boolean> | undefined, row: Record<string, unknown>) {
  if (!select) return row;
  return Object.fromEntries(Object.entries(row).filter(([chave]) => select[chave] === true));
}

function setup(encontrada: unknown = linha) {
  const prisma = {
    paymentWebhookEvent: {
      findUnique: jest.fn().mockResolvedValue(encontrada),
      findMany: jest
        .fn()
        .mockImplementation(({ select }: any) => Promise.resolve([projetar(select, linha)])),
      count: jest.fn().mockResolvedValue(1),
      groupBy: jest
        .fn()
        .mockResolvedValue([{ status: WebhookEventStatus.failed, _count: { _all: 2 } }]),
    },
    $transaction: jest.fn().mockImplementation((ops: any[]) => Promise.all(ops)),
  } as any;

  const audit = { recordBestEffort: jest.fn().mockResolvedValue(undefined) } as any;

  return { service: new OpsPaymentsQueryService(prisma, audit), prisma, audit };
}

describe('OpsPaymentsQueryService', () => {
  describe('list', () => {
    it('pagina com 10 por padrão, mais recentes primeiro', async () => {
      const { service, prisma } = setup();

      const resultado = await service.list({});

      const [args] = prisma.paymentWebhookEvent.findMany.mock.calls[0];
      expect(args.take).toBe(10);
      expect(args.skip).toBe(0);
      expect(args.orderBy).toEqual({ receivedAt: 'desc' });
      expect(resultado).toMatchObject({ total: 1, page: 1, pageSize: 10 });
    });

    it('não devolve o payload na listagem', async () => {
      const { service } = setup();

      const { items } = await service.list({});

      expect(items[0]).not.toHaveProperty('sanitizedPayload');
      expect(items[0]).not.toHaveProperty('payload');
    });

    it('combina os filtros num único where', async () => {
      const { service, prisma } = setup();

      await service.list({
        status: WebhookEventStatus.failed,
        eventType: 'PAYMENT_RECEIVED',
        providerEventId: 'evt_asaas_1',
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-10T00:00:00.000Z',
      });

      const [args] = prisma.paymentWebhookEvent.findMany.mock.calls[0];
      expect(args.where).toEqual({
        status: WebhookEventStatus.failed,
        eventType: 'PAYMENT_RECEIVED',
        providerEventId: 'evt_asaas_1',
        receivedAt: {
          gte: new Date('2026-09-01T00:00:00.000Z'),
          lte: new Date('2026-09-10T00:00:00.000Z'),
        },
      });
    });

    it('sem filtro de período não restringe a data', async () => {
      const { service, prisma } = setup();

      await service.list({ status: WebhookEventStatus.failed });

      const [args] = prisma.paymentWebhookEvent.findMany.mock.calls[0];
      expect(args.where).not.toHaveProperty('receivedAt');
    });
  });

  describe('detail', () => {
    it('mascara a identidade do cliente para quem não tem permissão', async () => {
      const { service, audit } = setup();

      const detalhe = await service.detail('evt-1', semPermissao);

      expect(detalhe.sensitiveRevealed).toBe(false);
      expect(detalhe.payload).toEqual({
        event: 'PAYMENT_RECEIVED',
        customer: { name: 'Bruno F.', email: 'b****@vellun.com.br' },
      });
      // Sem revelação não há o que auditar.
      expect(audit.recordBestEffort).not.toHaveBeenCalled();
    });

    it('devolve em claro para canViewSensitive e registra quem viu', async () => {
      const { service, audit } = setup();

      const detalhe = await service.detail('evt-1', comPermissao);

      expect(detalhe.sensitiveRevealed).toBe(true);
      expect(detalhe.payload).toEqual(linha.sanitizedPayload);
      expect(audit.recordBestEffort).toHaveBeenCalledWith(
        expect.objectContaining({
          operatorId: comPermissao.id,
          action: OPS_AUDIT_ACTIONS.sensitiveViewed,
          targetType: OPS_AUDIT_TARGETS.paymentWebhookEvent,
          targetId: 'evt-1',
        }),
      );
    });

    it('404 quando o evento não existe', async () => {
      const { service } = setup(null);

      await expect(service.detail('sumiu', comPermissao)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('countByStatus', () => {
    it('devolve todos os status, inclusive os zerados', async () => {
      const { service } = setup();

      expect(await service.countByStatus()).toEqual({
        received: 0,
        processing: 0,
        processed: 0,
        failed: 2,
        exhausted: 0,
      });
    });
  });
});
