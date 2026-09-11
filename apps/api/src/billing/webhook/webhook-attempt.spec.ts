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
      findUnique: jest.fn().mockResolvedValue({ attempts: 1 }),
    },
    subscription: { findFirst: jest.fn() },
  };
  const events = {
    markProcessing: jest.fn().mockResolvedValue(true),
    markProcessed: jest.fn().mockResolvedValue({}),
    markFailed: jest.fn().mockResolvedValue({ status: 'failed', nextRetryAt: new Date() }),
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
    expect(events.markFailed).toHaveBeenCalledWith('row_1', 'PSP fora', 1);
    // Nenhum timer pendente: a próxima tentativa é do cron, e sobrevive a deploy.
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  it('o número da tentativa vem do banco, não de uma variável local', async () => {
    const { processor, prisma, events } = setup();
    prisma.paymentWebhookEvent.findUnique.mockResolvedValue({ attempts: 4 });
    jest.spyOn(processor, 'process').mockRejectedValue(new Error('PSP fora'));

    await processor.attempt('row_1');

    // É isto que permite a tentativa 5 acontecer em OUTRO processo, depois de
    // um deploy que derrubou o que fez as quatro primeiras.
    expect(events.markFailed).toHaveBeenCalledWith('row_1', 'PSP fora', 4);
  });

  it('esgotado é desfecho próprio, não mais um retry', async () => {
    const { processor, events } = setup();
    events.markFailed.mockResolvedValue({ status: 'exhausted', nextRetryAt: null });
    jest.spyOn(processor, 'process').mockRejectedValue(new Error('PSP fora'));

    expect(await processor.attempt('row_1')).toBe('exhausted');
  });

  it('não consegue nem ler as tentativas: assume a primeira e segue', async () => {
    const { processor, prisma, events } = setup();
    prisma.paymentWebhookEvent.findUnique.mockRejectedValue(new Error('banco fora'));
    jest.spyOn(processor, 'process').mockRejectedValue(new Error('PSP fora'));

    // Perder o registro da falha seria pior do que registrá-la como primeira.
    await expect(processor.attempt('row_1')).resolves.toBe('retry_scheduled');
    expect(events.markFailed).toHaveBeenCalledWith('row_1', 'PSP fora', 1);
  });

  it('falha ao gravar a falha não propaga: o cron ainda varre', async () => {
    const { processor, events } = setup();
    events.markFailed.mockRejectedValue(new Error('banco fora'));
    jest.spyOn(processor, 'process').mockRejectedValue(new Error('PSP fora'));

    await expect(processor.attempt('row_1')).resolves.toBe('retry_scheduled');
  });

  it('erro que não é Error vira mensagem, não "[object Object]" silencioso', async () => {
    const { processor, events } = setup();
    jest.spyOn(processor, 'process').mockRejectedValue('string solta');

    await processor.attempt('row_1');

    expect(events.markFailed).toHaveBeenCalledWith('row_1', 'string solta', 1);
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
