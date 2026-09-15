import { SubscriptionStateService } from '../services/subscription-state.service';
import { WebhookProcessor } from './webhook.processor';

/**
 * `enqueue` e `attempt` — o caminho de falha do webhook, que até a Entrega 8
 * não tinha teste nenhum (o spec cobria só `process()`).
 *
 * O que estes testes fixam é a **durabilidade**: nenhuma tentativa futura pode
 * depender de um timer em memória, porque um deploy no meio da janela perdia o
 * evento.
 */
function setup() {
  const prisma = {
    paymentWebhookEvent: {
      findUniqueOrThrow: jest.fn(),
      findUnique: jest.fn(),
    },
    subscription: { findFirst: jest.fn() },
  };
  const events = {
    markProcessing: jest.fn().mockResolvedValue(true),
    markProcessed: jest.fn().mockResolvedValue({}),
    markFailed: jest
      .fn()
      .mockResolvedValue({ status: 'failed', attempts: 1, nextRetryAt: new Date() }),
    linkSubscription: jest.fn().mockResolvedValue(undefined),
  };

  const processor = new WebhookProcessor(
    { normalizeWebhookEvent: jest.fn(), getSubscription: jest.fn() } as any,
    prisma as any,
    events as any,
    { transitionTo: jest.fn() } as any,
    new SubscriptionStateService(),
    { upsertFromProvider: jest.fn() } as any,
  );

  return { processor, prisma, events };
}

describe('WebhookProcessor.attempt', () => {
  it('sucesso não agenda retry', async () => {
    const { processor, events } = setup();
    jest.spyOn(processor, 'process').mockResolvedValue(true);

    expect(await processor.attempt('row_1')).toBe('processed');
    expect(events.markFailed).not.toHaveBeenCalled();
  });

  it('evento que outro processo levou não é tratado como falha', async () => {
    const { processor, events } = setup();
    jest.spyOn(processor, 'process').mockResolvedValue(false);

    expect(await processor.attempt('row_1')).toBe('skipped');
    expect(events.markFailed).not.toHaveBeenCalled();
  });

  it('falha agenda a próxima tentativa NO BANCO, sem timer em memória', async () => {
    jest.useFakeTimers();
    const { processor, events } = setup();
    jest.spyOn(processor, 'process').mockRejectedValue(new Error('PSP fora'));

    const desfecho = await processor.attempt('row_1');

    expect(desfecho).toBe('retry_scheduled');
    expect(events.markFailed).toHaveBeenCalledWith('row_1', 'PSP fora');
    // Nenhum timer pendente: a próxima tentativa é do cron, e sobrevive a deploy.
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  it('não lê a contagem de tentativas por fora do markFailed', async () => {
    const { processor, prisma } = setup();
    jest.spyOn(processor, 'process').mockRejectedValue(new Error('PSP fora'));

    await processor.attempt('row_1');

    // A leitura separada existia e tinha um fallback de `attempts = 1`: com o
    // banco instável, reiniciava o backoff no bucket de 30 s. Agora quem lê a
    // contagem é o `markFailed`, na mesma transação em que grava.
    expect(prisma.paymentWebhookEvent.findUnique).not.toHaveBeenCalled();
  });

  it('esgotado é desfecho próprio, não mais um retry', async () => {
    const { processor, events } = setup();
    events.markFailed.mockResolvedValue({ status: 'exhausted', attempts: 6, nextRetryAt: null });
    jest.spyOn(processor, 'process').mockRejectedValue(new Error('PSP fora'));

    expect(await processor.attempt('row_1')).toBe('exhausted');
  });

  it('se nem a falha pode ser gravada, diz isso — não finge que reagendou', async () => {
    const { processor, events } = setup();
    events.markFailed.mockRejectedValue(new Error('banco fora'));
    jest.spyOn(processor, 'process').mockRejectedValue(new Error('PSP fora'));

    // Antes devolvia `retry_scheduled` mesmo sem ter gravado nada. A linha fica
    // em `processing`, e a varredura de presos a devolve à fila depois.
    await expect(processor.attempt('row_1')).resolves.toBe('unrecorded');
  });

  it('erro que não é Error vira mensagem, não "[object Object]" silencioso', async () => {
    const { processor, events } = setup();
    jest.spyOn(processor, 'process').mockRejectedValue('string solta');

    await processor.attempt('row_1');

    expect(events.markFailed).toHaveBeenCalledWith('row_1', 'string solta');
  });
});

describe('WebhookProcessor.enqueue', () => {
  it('não bloqueia a resposta ao PSP: a tentativa é agendada', async () => {
    const { processor } = setup();
    const attempt = jest.spyOn(processor, 'attempt').mockResolvedValue('processed');

    processor.enqueue('row_1');

    // Ainda não rodou — `setImmediate` é o que mantém o webhook respondendo rápido.
    expect(attempt).not.toHaveBeenCalled();

    await new Promise((resolve) => setImmediate(resolve));
    expect(attempt).toHaveBeenCalledWith('row_1');
  });

  it('uma tentativa que falha não derruba o processo', async () => {
    const { processor } = setup();
    jest.spyOn(processor, 'attempt').mockRejectedValue(new Error('explodiu'));

    expect(() => processor.enqueue('row_1')).not.toThrow();
  });
});
