import { LokiTransport } from './loki-transport';

/** Captura as chamadas de `fetch` e permite controlar a resposta. */
function stubFetch(respond: (body: any) => { ok: boolean; status: number } | Promise<never>): {
  calls: any[];
} {
  const calls: any[] = [];
  (globalThis as any).fetch = jest.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return respond(body) as any;
  });
  return { calls };
}

const ok = () => ({ ok: true, status: 204 });

describe('LokiTransport', () => {
  const originalFetch = globalThis.fetch;
  const criados: LokiTransport[] = [];

  afterEach(async () => {
    // Um transporte com o destino fora reagenda indefinidamente (é o
    // comportamento correto de um remetente de log). Sem encerrar, o timer
    // pendente mantém a suíte aberta.
    for (const transport of criados.splice(0)) {
      transport.dispose();
    }
    (globalThis as any).fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function build(overrides: Record<string, unknown> = {}) {
    const transport = new LokiTransport({
      url: 'http://alloy:3100',
      labels: { service: 'api', env: 'test' },
      flushIntervalMs: 5,
      ...(overrides as any),
    });
    criados.push(transport);
    return transport;
  }

  it('envia no formato de push do Loki, com timestamp em nanossegundos', async () => {
    const { calls } = stubFetch(ok);
    const transport = build();

    transport.push('{"message":"olá"}');
    await transport.flush();

    expect(calls).toHaveLength(1);
    const [stream] = calls[0].streams;
    expect(stream.stream).toEqual({ service: 'api', env: 'test' });
    expect(stream.values).toHaveLength(1);
    const [timestampNs, line] = stream.values[0];
    // Nanossegundos: 19 dígitos nesta era. Enviar milissegundos faria o Loki
    // colocar toda linha em 1970.
    expect(timestampNs).toMatch(/^\d{19}$/);
    expect(line).toBe('{"message":"olá"}');
  });

  it('usa apenas labels de conjunto fechado', async () => {
    // No Loki, label é índice: `correlationId` como label criaria um stream por
    // requisição. Ele vai no corpo da linha.
    const { calls } = stubFetch(ok);
    const transport = build();

    transport.push('{"correlationId":"abc-123"}');
    await transport.flush();

    expect(Object.keys(calls[0].streams[0].stream).sort()).toEqual(['env', 'service']);
  });

  it('agrupa várias linhas em um lote', async () => {
    const { calls } = stubFetch(ok);
    const transport = build();

    for (let i = 0; i < 5; i++) transport.push(`linha ${i}`);
    await transport.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].streams[0].values).toHaveLength(5);
  });

  it('não lança quando a rede falha', async () => {
    // Observabilidade que derruba o que observa é pior que nenhuma.
    (globalThis as any).fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const transport = build();

    transport.push('linha');
    await expect(transport.flush()).resolves.toBeUndefined();
  });

  it('preserva o lote para nova tentativa em erro 5xx', async () => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stubFetch(() => ({ ok: false, status: 503 }));
    const transport = build();

    transport.push('linha');
    await transport.flush();

    // Continua pendente: um Alloy reiniciando não deve custar o log.
    expect(transport.pending).toBe(1);
  });

  it('descarta o lote em erro 4xx', async () => {
    // Lote malformado ou label inválido não melhora com retry, e reter
    // seguraria o buffer para sempre.
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stubFetch(() => ({ ok: false, status: 400 }));
    const transport = build();

    transport.push('linha');
    await transport.flush();

    expect(transport.pending).toBe(0);
  });

  it('retenta em 429, que é pressão e não erro de formato', async () => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stubFetch(() => ({ ok: false, status: 429 }));
    const transport = build();

    transport.push('linha');
    await transport.flush();

    expect(transport.pending).toBe(1);
  });

  it('descarta a linha mais antiga quando o buffer enche', async () => {
    // Durante um incidente, a linha recente é a que explica o que está
    // acontecendo agora.
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { calls } = stubFetch(ok);
    const transport = build({ maxBuffer: 3 } as any);

    for (const linha of ['a', 'b', 'c', 'd', 'e']) transport.push(linha);
    await transport.flush();

    expect(transport.dropped).toBe(2);
    expect(calls[0].streams[0].values.map((v: string[]) => v[1])).toEqual(['c', 'd', 'e']);
  });

  it('não cresce sem limite com o destino fora', async () => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    (globalThis as any).fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const transport = build({ maxBuffer: 10 } as any);

    for (let i = 0; i < 100; i++) transport.push(`linha ${i}`);
    await transport.flush();

    expect(transport.pending).toBeLessThanOrEqual(10);
    expect(transport.dropped).toBeGreaterThan(0);
  });

  it('descarrega o que resta no stop e para de aceitar linhas', async () => {
    const { calls } = stubFetch(ok);
    const transport = build();

    transport.push('antes do stop');
    await transport.stop();
    transport.push('depois do stop');

    expect(calls).toHaveLength(1);
    expect(calls[0].streams[0].values[0][1]).toBe('antes do stop');
    // Aceitar linha depois do stop poderia realimentar o buffer durante o flush.
    expect(transport.pending).toBe(0);
  });

  it('não chama a rede quando não há nada pendente', async () => {
    const { calls } = stubFetch(ok);
    const transport = build();

    await transport.flush();

    expect(calls).toHaveLength(0);
  });

  /**
   * Substitui o `setTimeout` por um timer controlado pelo teste.
   *
   * Registra o atraso pedido e guarda o callback, para o teste decidir quando o
   * timer "dispara". Um mock que nunca dispara não serviria: o `schedule` é
   * idempotente enquanto há timer pendente, então sem disparo o agendamento
   * seguinte nunca aconteceria.
   */
  function controlaTimer(ignorarMs: number): {
    atrasos: number[];
    disparar: () => Promise<void>;
  } {
    const atrasos: number[] = [];
    let callback: (() => void) | null = null;

    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      // O `AbortController` do `fetch` também usa `setTimeout`; só o agendamento
      // do flush interessa aqui, e ele é o único que não usa `timeoutMs`.
      if (ms === ignorarMs) return { unref: () => undefined } as any;

      atrasos.push(ms ?? 0);
      callback = fn;
      return { unref: () => undefined } as any;
    }) as any);

    return {
      atrasos,
      disparar: async () => {
        const fn = callback;
        callback = null;
        fn?.();
        // Deixa o flush disparado pelo timer concluir.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      },
    };
  }

  it('espaça as tentativas a cada falha consecutiva', async () => {
    // Sem backoff, um Alloy sob pressão é martelado a taxa fixa por cada réplica
    // exatamente quando menos aguenta.
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stubFetch(() => ({ ok: false, status: 503 }));
    const { atrasos, disparar } = controlaTimer(7777);
    const transport = build({ flushIntervalMs: 100, timeoutMs: 7777 });

    transport.push('linha');
    await disparar();
    await disparar();

    // Intervalo normal na primeira, dobrando a cada falha consecutiva.
    expect(atrasos.slice(0, 3)).toEqual([100, 200, 400]);
  });

  it('volta ao intervalo normal depois de um sucesso', async () => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let falhar = true;
    (globalThis as any).fetch = jest.fn(async () =>
      falhar ? { ok: false, status: 503 } : { ok: true, status: 204 },
    );
    const { atrasos, disparar } = controlaTimer(7777);
    const transport = build({ flushIntervalMs: 100, timeoutMs: 7777 });

    transport.push('a');
    await disparar(); // falha → backoff
    expect(atrasos).toEqual([100, 200]);

    falhar = false;
    await disparar(); // sucesso → buffer vazio, nada reagendado
    expect(atrasos).toEqual([100, 200]);

    transport.push('b');
    expect(atrasos).toEqual([100, 200, 100]);
  });

  it('limita o backoff a um teto', async () => {
    // Um destino fora por horas não deve levar o intervalo a dias.
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stubFetch(() => ({ ok: false, status: 503 }));
    const { atrasos, disparar } = controlaTimer(7777);
    const transport = build({ flushIntervalMs: 2000, timeoutMs: 7777 });

    transport.push('linha');
    for (let i = 0; i < 12; i++) await disparar();

    expect(atrasos.at(-1)).toBe(60_000);
  });
});
