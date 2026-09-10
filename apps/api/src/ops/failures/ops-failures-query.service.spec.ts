import { NotFoundException } from '@nestjs/common';
import { OpsAuditResult, OpsFailureSource, OpsFailureStatus, OpsRole } from '@prisma/client';

import { OPS_AUDIT_ACTIONS } from '../ops.constants';
import { OpsFailuresQueryService } from './ops-failures-query.service';

const linha = {
  id: 'falha-1',
  source: OpsFailureSource.whatsapp_inbound,
  sourceQueue: 'whatsapp.inbound.v1',
  status: OpsFailureStatus.pending,
  errorType: 'ConnectionError',
  errorMessage: 'API fora',
  attempts: 5,
  permanent: false,
  correlationId: 'corr-1',
  phoneHash: 'abc123def456',
  firstFailedAt: new Date('2026-09-05T17:59:12.000Z'),
  failedAt: new Date('2026-09-05T18:00:00.000Z'),
  capturedAt: new Date('2026-09-05T18:00:05.000Z'),
  providerMessageId: 'wamid.abc',
  jobId: null,
  payload: { phone: '+5541999998877', text: 'gastei 47,50 no mercado' },
  reprocessedAt: null,
  retentionUntil: new Date('2027-03-04T18:00:05.000Z'),
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

/**
 * Projeta a linha conforme o `select`, como o Prisma faria.
 *
 * Um dublê que devolve a linha inteira ignorando o `select` faria a asserção
 * "a listagem não devolve payload" verificar o mock, não o código.
 */
function projetar(select: Record<string, boolean> | undefined, row: Record<string, unknown>) {
  if (!select) return row;

  return Object.fromEntries(Object.entries(row).filter(([chave]) => select[chave] === true));
}

function setup(encontrada: unknown = linha) {
  const prisma = {
    opsFailedMessage: {
      findUnique: jest.fn().mockResolvedValue(encontrada),
      findMany: jest
        .fn()
        .mockImplementation(({ select }: any) => Promise.resolve([projetar(select, linha)])),
      count: jest.fn().mockResolvedValue(1),
      groupBy: jest
        .fn()
        .mockResolvedValue([{ status: OpsFailureStatus.pending, _count: { _all: 3 } }]),
    },
    $transaction: jest.fn().mockImplementation((ops: any[]) => Promise.all(ops)),
  } as any;

  const audit = { recordBestEffort: jest.fn().mockResolvedValue(undefined) } as any;

  return { service: new OpsFailuresQueryService(prisma, audit), prisma, audit };
}

describe('OpsFailuresQueryService.detail', () => {
  it('mascara o payload para operador sem canViewSensitive', async () => {
    // Critério de aceite: telefone aparece mascarado para `operator` sem a
    // permissão específica.
    const { service } = setup();

    const detalhe = await service.detail('falha-1', semPermissao);
    const payload = detalhe.payload as Record<string, string>;

    expect(payload.phone).toBe('5541*******77');
    expect(payload.text).not.toBe('gastei 47,50 no mercado');
    expect(detalhe.sensitiveRevealed).toBe(false);
  });

  it('não audita quando o payload saiu mascarado', async () => {
    // Ver o mascarado é a leitura normal do painel; auditar isso afogaria a
    // trilha e escondria as visualizações que importam.
    const { service, audit } = setup();

    await service.detail('falha-1', semPermissao);

    expect(audit.recordBestEffort).not.toHaveBeenCalled();
  });

  it('devolve o payload em claro para quem tem a permissão', async () => {
    const { service } = setup();

    const detalhe = await service.detail('falha-1', comPermissao);
    const payload = detalhe.payload as Record<string, string>;

    expect(payload.phone).toBe('+5541999998877');
    expect(payload.text).toBe('gastei 47,50 no mercado');
    expect(detalhe.sensitiveRevealed).toBe(true);
  });

  it('audita cada visualização em claro', async () => {
    // A permissão diz quem pode; a auditoria diz quem viu.
    const { service, audit } = setup();

    await service.detail('falha-1', comPermissao);

    expect(audit.recordBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: 'op-2',
        action: OPS_AUDIT_ACTIONS.sensitiveViewed,
        targetId: 'falha-1',
        result: OpsAuditResult.success,
      }),
    );
  });

  it('recusa id inexistente', async () => {
    const { service } = setup(null);

    await expect(service.detail('nao-existe', comPermissao)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('OpsFailuresQueryService.list', () => {
  it('não devolve payload na listagem', async () => {
    // A lista não precisa dele, e trafegar payload de todas as falhas seria
    // expor muito mais superfície do que a tela usa.
    const { service, prisma } = setup();

    const pagina = await service.list({});

    expect(pagina.items[0]).not.toHaveProperty('payload');
    const select = prisma.opsFailedMessage.findMany.mock.calls[0][0].select;
    expect(select.payload).toBeUndefined();
  });

  it('usa 10 por página como padrão', async () => {
    // Regra do projeto: lista confortável em mobile.
    const { service, prisma } = setup();

    const pagina = await service.list({});

    expect(pagina.pageSize).toBe(10);
    expect(prisma.opsFailedMessage.findMany.mock.calls[0][0].take).toBe(10);
  });

  it('pagina a partir de 1', async () => {
    const { service, prisma } = setup();

    await service.list({ page: 3, pageSize: 20 });

    expect(prisma.opsFailedMessage.findMany.mock.calls[0][0].skip).toBe(40);
  });

  it('ordena pelo mais recente', async () => {
    // A investigação começa pelo que acabou de falhar.
    const { service, prisma } = setup();

    await service.list({});

    expect(prisma.opsFailedMessage.findMany.mock.calls[0][0].orderBy).toEqual({
      capturedAt: 'desc',
    });
  });

  it('combina os filtros de fila, tipo de erro e correlação', async () => {
    const { service, prisma } = setup();

    await service.list({
      status: OpsFailureStatus.pending,
      source: OpsFailureSource.whatsapp_processing,
      sourceQueue: 'whatsapp.processing.v1',
      errorType: 'TimeoutError',
      correlationId: 'corr-9',
    });

    expect(prisma.opsFailedMessage.findMany.mock.calls[0][0].where).toEqual({
      status: OpsFailureStatus.pending,
      source: OpsFailureSource.whatsapp_processing,
      sourceQueue: 'whatsapp.processing.v1',
      errorType: 'TimeoutError',
      correlationId: 'corr-9',
    });
  });

  it('filtra por período sobre capturedAt', async () => {
    const { service, prisma } = setup();

    await service.list({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-10T00:00:00.000Z' });

    expect(prisma.opsFailedMessage.findMany.mock.calls[0][0].where.capturedAt).toEqual({
      gte: new Date('2026-09-01T00:00:00.000Z'),
      lte: new Date('2026-09-10T00:00:00.000Z'),
    });
  });

  it('aceita só um dos lados do período', async () => {
    const { service, prisma } = setup();

    await service.list({ from: '2026-09-01T00:00:00.000Z' });

    expect(prisma.opsFailedMessage.findMany.mock.calls[0][0].where.capturedAt).toEqual({
      gte: new Date('2026-09-01T00:00:00.000Z'),
    });
  });
});

describe('OpsFailuresQueryService.countByStatus', () => {
  it('inclui os status zerados', async () => {
    // Um painel que omite "zero descartadas" faz parecer que a informação não
    // existe.
    const { service } = setup();

    await expect(service.countByStatus()).resolves.toEqual({
      pending: 3,
      reprocessing: 0,
      reprocessed: 0,
      discarded: 0,
    });
  });
});
