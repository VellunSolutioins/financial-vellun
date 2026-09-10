import { OpsFailureSource } from '@prisma/client';

import {
  CaptureFailureInput,
  OpsFailedMessagesService,
  RETENTION_DAYS,
  hashPhone,
  retentionFor,
} from './ops-failed-messages.service';

const envelope: CaptureFailureInput = {
  source: OpsFailureSource.whatsapp_inbound,
  sourceQueue: 'whatsapp.inbound.v1',
  routingKey: 'inbound',
  correlationId: 'corr-1',
  attempts: 5,
  errorType: 'ConnectionError',
  errorMessage: 'API fora',
  permanent: false,
  payload: {
    phone: '+5541999998877',
    text: 'gastei 47,50',
    providerMessageId: 'wamid.abc',
  } as never,
  firstFailedAt: '2026-09-05T17:59:12.000Z',
  failedAt: '2026-09-05T18:00:00.000Z',
};

function setup(existente: { id: string } | null = null) {
  const criadas: any[] = [];
  const prisma = {
    opsFailedMessage: {
      findUnique: jest.fn().mockResolvedValue(existente),
      create: jest.fn().mockImplementation(({ data }: any) => {
        criadas.push(data);
        return Promise.resolve({ id: 'nova-falha' });
      }),
    },
  } as any;

  return { service: new OpsFailedMessagesService(prisma), prisma, criadas };
}

describe('OpsFailedMessagesService.capture', () => {
  it('registra a falha com o payload íntegro', async () => {
    // O payload é o que será republicado: guardá-lo alterado tornaria o
    // reprocessamento impossível.
    const { service, criadas } = setup();

    await expect(service.capture(envelope)).resolves.toEqual({
      id: 'nova-falha',
      duplicate: false,
    });
    expect(criadas[0].payload).toEqual(envelope.payload);
    expect(criadas[0].errorType).toBe('ConnectionError');
    expect(criadas[0].attempts).toBe(5);
  });

  it('extrai o telefone como hash, nunca em claro na coluna', async () => {
    const { service, criadas } = setup();

    await service.capture(envelope);

    expect(criadas[0].phoneHash).toBe(hashPhone('+5541999998877'));
    expect(criadas[0].phoneHash).not.toContain('5541999998877');
  });

  it('extrai providerMessageId de uma mensagem individual', async () => {
    const { service, criadas } = setup();

    await service.capture(envelope);

    expect(criadas[0].providerMessageId).toBe('wamid.abc');
  });

  it('extrai o primeiro providerMessageIds de um job consolidado', async () => {
    // `ProcessingJobV1` traz a lista, porque o job consolida várias mensagens.
    const { service, criadas } = setup();

    await service.capture({
      ...envelope,
      source: OpsFailureSource.whatsapp_processing,
      payload: {
        jobId: 'job-1',
        phone: '+5541999998877',
        providerMessageIds: ['wamid.1', 'wamid.2'],
      } as never,
    });

    expect(criadas[0].providerMessageId).toBe('wamid.1');
    expect(criadas[0].jobId).toBe('job-1');
  });

  it('devolve duplicate sem criar linha nova quando a chave já existe', async () => {
    // O consumer pode reentregar a mesma mensagem — um nack depois de uma
    // gravação que expirou por timeout. Sem isso, a mesma falha apareceria duas
    // vezes no painel e seria reprocessada duas vezes.
    const { service, prisma } = setup({ id: 'ja-existe' });

    await expect(service.capture(envelope)).resolves.toEqual({
      id: 'ja-existe',
      duplicate: true,
    });
    expect(prisma.opsFailedMessage.create).not.toHaveBeenCalled();
  });

  it('calcula a retenção a partir do status', async () => {
    const { service, criadas } = setup();

    await service.capture(envelope);

    const capturedAt: Date = criadas[0].capturedAt;
    const esperado = capturedAt.getTime() + RETENTION_DAYS.pending * 24 * 60 * 60 * 1000;
    expect((criadas[0].retentionUntil as Date).getTime()).toBe(esperado);
  });
});

describe('OpsFailedMessagesService.buildDedupeKey', () => {
  const { service } = setup();

  it('é estável para o mesmo envelope', () => {
    expect(service.buildDedupeKey(envelope)).toBe(service.buildDedupeKey({ ...envelope }));
  });

  it('muda quando a falha é nova, mesmo para a mesma mensagem', () => {
    // Uma falha nova depois de um reprocessamento que não deu certo precisa
    // gerar linha nova, senão o catálogo diria que ela só falhou uma vez.
    const outra = { ...envelope, failedAt: '2026-09-05T19:30:00.000Z' };

    expect(service.buildDedupeKey(outra)).not.toBe(service.buildDedupeKey(envelope));
  });

  it('distingue mensagens diferentes que falharam no mesmo instante', () => {
    const outra = {
      ...envelope,
      payload: { phone: '+5541999998877', text: 'outra coisa' } as never,
    };

    expect(service.buildDedupeKey(outra)).not.toBe(service.buildDedupeKey(envelope));
  });

  it('distingue filas diferentes', () => {
    const outra = { ...envelope, sourceQueue: 'whatsapp.processing.v1' };

    expect(service.buildDedupeKey(outra)).not.toBe(service.buildDedupeKey(envelope));
  });
});

describe('hashPhone', () => {
  it('bate com o hash do agente: sha256 do E.164, 12 hex', () => {
    // Precisa bater, porque é assim que uma falha do catálogo se liga a uma
    // linha de log do agente.
    const hash = hashPhone('+5541999998877');

    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    // Formato não-canônico chega ao mesmo hash.
    expect(hashPhone('(41) 99999-8877')).toBe(hash);
  });

  it('devolve nulo sem telefone', () => {
    expect(hashPhone(null)).toBeNull();
  });
});

describe('retentionFor', () => {
  it('mantém o que ainda espera ação por mais tempo que o resolvido', () => {
    const agora = new Date('2026-09-10T00:00:00.000Z');

    expect(retentionFor('pending', agora).getTime()).toBeGreaterThan(
      retentionFor('reprocessed', agora).getTime(),
    );
  });
});
