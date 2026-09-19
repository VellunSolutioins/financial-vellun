import { NotFoundException } from '@nestjs/common';
import { OpsAuditResult, OpsFailureSource, OpsFailureStatus, OpsRole } from '@prisma/client';

import { OPS_AUDIT_ACTIONS } from '../ops.constants';
import { OpsFailuresActionsService } from './ops-failures-actions.service';

const operador = {
  id: 'op-1',
  githubLogin: 'operador',
  role: OpsRole.operator,
  canViewSensitive: false,
};

const linha = {
  source: OpsFailureSource.whatsapp_inbound,
  payload: { phone: '+5541999998877', text: 'gastei 47,50 no mercado' },
  correlationId: 'corr-1',
};

/**
 * Dublê do Prisma com status por id, para que `updateMany` respeite o `where` —
 * um mock que sempre devolve `count: 1` faria o teste do cadeado verificar o
 * dublê, não o serviço.
 */
function fakePrisma(statusPorId: Record<string, OpsFailureStatus>) {
  const opsFailedMessage = {
    findUnique: jest.fn(({ where }: any) =>
      Promise.resolve(
        statusPorId[where.id] ? { id: where.id, status: statusPorId[where.id] } : null,
      ),
    ),
    findUniqueOrThrow: jest.fn(() => Promise.resolve({ ...linha })),
    updateMany: jest.fn(({ where, data }: any) => {
      const atual = statusPorId[where.id];
      const esperado = where.status;
      const casa =
        esperado === undefined
          ? atual !== undefined
          : typeof esperado === 'object'
            ? esperado.in.includes(atual)
            : atual === esperado;
      if (!casa) return Promise.resolve({ count: 0 });
      statusPorId[where.id] = data.status;
      return Promise.resolve({ count: 1 });
    }),
  };

  const prisma: any = {
    opsFailedMessage,
    $transaction: jest.fn((fn: any) => fn(prisma)),
  };
  return prisma;
}

function setup(
  desfecho: any = { status: 'published' },
  statusPorId: Record<string, OpsFailureStatus> = { 'falha-1': OpsFailureStatus.pending },
) {
  const prisma = fakePrisma(statusPorId);
  const audit = {
    newOperationId: jest.fn().mockReturnValue('oper-1'),
    record: jest.fn().mockResolvedValue('audit-1'),
    recordBestEffort: jest.fn().mockResolvedValue(undefined),
  } as any;
  const agent = {
    republish: jest.fn().mockResolvedValue(desfecho),
  } as any;

  return {
    service: new OpsFailuresActionsService(prisma, audit, agent),
    prisma,
    audit,
    agent,
    statusPorId,
  };
}

describe('OpsFailuresActionsService', () => {
  describe('reprocessOne', () => {
    it('deriva o destino da origem, nunca do pedido', async () => {
      const { service, agent } = setup();

      await service.reprocessOne('falha-1', 'API voltou', operador);

      expect(agent.republish).toHaveBeenCalledWith({
        route: 'inbound',
        payload: linha.payload,
        correlationId: 'corr-1',
      });
    });

    it('republica e marca reprocessed', async () => {
      const { service, statusPorId, audit } = setup();

      const resultado = await service.reprocessOne('falha-1', 'API voltou', operador);

      expect(resultado).toEqual({ id: 'falha-1', outcome: 'republished' });
      expect(statusPorId['falha-1']).toBe(OpsFailureStatus.reprocessed);
      expect(audit.recordBestEffort).toHaveBeenCalledWith(
        expect.objectContaining({
          action: OPS_AUDIT_ACTIONS.failureReprocessPublished,
          result: OpsAuditResult.success,
        }),
      );
    });

    it('registra a solicitação na MESMA transação da reivindicação', async () => {
      const { service, prisma, audit } = setup();

      await service.reprocessOne('falha-1', 'API voltou', operador);

      // O segundo argumento é o cliente da transação: sem ele, uma queda entre
      // reivindicar e auditar deixaria a ação feita e sem rastro.
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: OPS_AUDIT_ACTIONS.failureReprocessRequested }),
        prisma,
      );
    });

    it('não reprocessa o que não está pendente', async () => {
      for (const status of [
        OpsFailureStatus.reprocessing,
        OpsFailureStatus.reprocessed,
        OpsFailureStatus.discarded,
      ]) {
        const { service, agent } = setup({ status: 'published' }, { 'falha-1': status });

        const resultado = await service.reprocessOne('falha-1', 'de novo', operador);

        expect(resultado.outcome).toBe('skipped');
        expect(agent.republish).not.toHaveBeenCalled();
      }
    });

    it('404 quando a falha não existe', async () => {
      const { service } = setup({ status: 'published' }, {});

      await expect(service.reprocessOne('sumiu', 'motivo', operador)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('recusa do agente devolve a falha para pendente', async () => {
      const { service, statusPorId } = setup({ status: 'rejected', reason: 'payload inválido' });

      const resultado = await service.reprocessOne('falha-1', 'tentando', operador);

      // Recusa é certeza de que nada foi publicado: a falha volta a ser
      // trabalho a fazer, não some.
      expect(resultado.outcome).toBe('rejected');
      expect(statusPorId['falha-1']).toBe(OpsFailureStatus.pending);
    });

    it('sem desfecho conhecido, a linha FICA em reprocessing', async () => {
      const { service, statusPorId, audit } = setup({ status: 'unknown', reason: 'timeout' });

      const resultado = await service.reprocessOne('falha-1', 'tentando', operador);

      // Devolver a pending arriscaria publicar a mesma mensagem duas vezes;
      // marcar reprocessed esconderia uma que talvez nunca tenha saído.
      expect(resultado.outcome).toBe('unresolved');
      expect(statusPorId['falha-1']).toBe(OpsFailureStatus.reprocessing);
      expect(audit.recordBestEffort).toHaveBeenCalledWith(
        expect.objectContaining({ result: OpsAuditResult.failure }),
      );
    });
  });

  describe('reprocessMany', () => {
    it('agrupa o lote inteiro sob um operationId', async () => {
      const { service } = setup(
        { status: 'published' },
        {
          a: OpsFailureStatus.pending,
          b: OpsFailureStatus.pending,
        },
      );

      const resultado = await service.reprocessMany(['a', 'b'], 'lote', operador);

      expect(resultado.operationId).toBe('oper-1');
      expect(resultado.items.map((item) => item.outcome)).toEqual(['republished', 'republished']);
      expect(resultado.aborted).toBe(false);
    });

    it('pula itens já tratados e segue com o resto', async () => {
      const { service, agent } = setup(
        { status: 'published' },
        {
          a: OpsFailureStatus.reprocessed,
          b: OpsFailureStatus.pending,
        },
      );

      const resultado = await service.reprocessMany(['a', 'b'], 'lote', operador);

      expect(resultado.items[0]).toMatchObject({ id: 'a', outcome: 'skipped' });
      expect(resultado.items[1]).toMatchObject({ id: 'b', outcome: 'republished' });
      expect(agent.republish).toHaveBeenCalledTimes(1);
    });

    it('interrompe o lote diante de falha sistêmica', async () => {
      const ids = ['a', 'b', 'c', 'd', 'e'];
      const status = Object.fromEntries(ids.map((id) => [id, OpsFailureStatus.pending]));
      const { service, agent } = setup({ status: 'unknown', reason: 'agente fora' }, status as any);

      const resultado = await service.reprocessMany(ids, 'lote', operador);

      // Três seguidas sem desfecho significam agente ou broker fora: insistir
      // nos outros só produziria mais linhas presas.
      expect(agent.republish).toHaveBeenCalledTimes(3);
      expect(resultado.aborted).toBe(true);
      expect(resultado.abortReason).toContain('item 3 de 5');
      expect(resultado.items.map((item) => item.outcome)).toEqual([
        'unresolved',
        'unresolved',
        'unresolved',
        'not_attempted',
        'not_attempted',
      ]);
    });

    it('um sucesso no meio zera a contagem de falhas seguidas', async () => {
      const ids = ['a', 'b', 'c', 'd'];
      const status = Object.fromEntries(ids.map((id) => [id, OpsFailureStatus.pending]));
      const { service, agent } = setup({ status: 'unknown', reason: 'x' }, status as any);

      agent.republish
        .mockResolvedValueOnce({ status: 'unknown', reason: 'x' })
        .mockResolvedValueOnce({ status: 'unknown', reason: 'x' })
        .mockResolvedValueOnce({ status: 'published' })
        .mockResolvedValueOnce({ status: 'unknown', reason: 'x' });

      const resultado = await service.reprocessMany(ids, 'lote', operador);

      expect(resultado.aborted).toBe(false);
      expect(agent.republish).toHaveBeenCalledTimes(4);
    });
  });

  describe('discard', () => {
    it('marca discarded e audita como pré-condição, na transação', async () => {
      const { service, statusPorId, audit, prisma } = setup();

      const resultado = await service.discard('falha-1', 'cliente já resolveu', operador);

      expect(resultado).toEqual({ id: 'falha-1', status: OpsFailureStatus.discarded });
      expect(statusPorId['falha-1']).toBe(OpsFailureStatus.discarded);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: OPS_AUDIT_ACTIONS.failureDiscarded }),
        prisma,
      );
    });

    it('não descarta o que está em reprocessing: pode já ter sido publicado', async () => {
      const { service } = setup(
        { status: 'published' },
        {
          'falha-1': OpsFailureStatus.reprocessing,
        },
      );

      await expect(service.discard('falha-1', 'motivo', operador)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404 quando a falha não existe', async () => {
      const { service } = setup({ status: 'published' }, {});

      await expect(service.discard('sumiu', 'motivo', operador)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
