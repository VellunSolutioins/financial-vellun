import { AgentReprocessClient } from './agent-reprocess.client';

const CHAVE_INTERNA = 'chave-interna';

const config = {
  get: (chave: string) =>
    ({ AI_AGENT_URL: 'http://agente:8010', INTERNAL_API_KEY: CHAVE_INTERNA })[chave],
} as any;

function resposta(status: number, corpo = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => corpo,
  } as unknown as Response;
}

const pedido = { route: 'inbound' as const, payload: { a: 1 }, correlationId: 'corr-1' };

describe('AgentReprocessClient', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch' as never);
  });
  afterEach(() => fetchSpy.mockRestore());

  it('envia rota, payload e correlação com a chave interna', async () => {
    fetchSpy.mockResolvedValue(resposta(200));

    await new AgentReprocessClient(config).republish(pedido);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://agente:8010/internal/ops/reprocess');
    expect((init.headers as Record<string, string>)['x-internal-api-key']).toBe('chave-interna');
    expect(JSON.parse(init.body as string)).toEqual({
      route: 'inbound',
      message: { a: 1 },
      correlationId: 'corr-1',
    });
  });

  it('2xx é publicação confirmada', async () => {
    fetchSpy.mockResolvedValue(resposta(200));

    expect(await new AgentReprocessClient(config).republish(pedido)).toEqual({
      status: 'published',
    });
  });

  it('4xx é recusa: certeza de que nada foi publicado', async () => {
    for (const status of [400, 401, 422]) {
      fetchSpy.mockResolvedValue(resposta(status, 'payload inválido'));

      const desfecho = await new AgentReprocessClient(config).republish(pedido);

      expect(desfecho.status).toBe('rejected');
    }
  });

  it('408 e 429 não são recusa: são "tente de novo"', async () => {
    for (const status of [408, 429]) {
      fetchSpy.mockResolvedValue(resposta(status));

      const desfecho = await new AgentReprocessClient(config).republish(pedido);

      // Tratá-los como recusa devolveria a falha a `pending` e alguém
      // republicaria uma mensagem que pode ter entrado.
      expect(desfecho.status).toBe('unknown');
    }
  });

  it('503 do broker sem confirm é desfecho desconhecido', async () => {
    fetchSpy.mockResolvedValue(resposta(503, 'broker não confirmou'));

    const desfecho = await new AgentReprocessClient(config).republish(pedido);

    expect(desfecho.status).toBe('unknown');
  });

  it('agente inalcançável é desconhecido, nunca recusa', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    const desfecho = await new AgentReprocessClient(config).republish(pedido);

    expect(desfecho).toMatchObject({ status: 'unknown' });
    expect((desfecho as { reason: string }).reason).toContain('ECONNREFUSED');
  });

  it('trunca o detalhe do erro, que vai para a auditoria e para a tela', async () => {
    fetchSpy.mockResolvedValue(resposta(422, 'x'.repeat(1000)));

    const desfecho = (await new AgentReprocessClient(config).republish(pedido)) as {
      reason: string;
    };

    expect(desfecho.reason.length).toBeLessThan(400);
  });
});
