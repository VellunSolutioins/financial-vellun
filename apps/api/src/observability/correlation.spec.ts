import {
  CORRELATION_HEADER,
  correlationHeaders,
  currentCorrelationId,
  runWithCorrelationId,
  sanitizeIncomingCorrelationId,
} from './correlation';

describe('sanitizeIncomingCorrelationId', () => {
  it('aceita um id seguro vindo de fora', () => {
    // É o que permite seguir o mesmo fluxo entre a API e o agente de IA.
    expect(sanitizeIncomingCorrelationId('abc-123_XY.7:8')).toBe('abc-123_XY.7:8');
  });

  it('usa o primeiro valor quando o header vem repetido', () => {
    expect(sanitizeIncomingCorrelationId(['primeiro', 'segundo'])).toBe('primeiro');
  });

  it('recusa quebra de linha, que injetaria uma linha falsa no log', () => {
    const gerado = sanitizeIncomingCorrelationId('ok\ninjetado');

    expect(gerado).not.toContain('\n');
    expect(gerado).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('recusa espaço, caractere de controle e id longo demais', () => {
    for (const entrada of ['com espaco', 'tab\there', 'x'.repeat(200)]) {
      expect(sanitizeIncomingCorrelationId(entrada)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('gera um id quando não vem nada', () => {
    for (const entrada of [undefined, null, '', '   ', 42, {}]) {
      expect(sanitizeIncomingCorrelationId(entrada)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe('contexto de correlação', () => {
  it('expõe o id dentro do escopo e o remove fora', () => {
    expect(currentCorrelationId()).toBeUndefined();

    runWithCorrelationId('corr-1', () => {
      expect(currentCorrelationId()).toBe('corr-1');
    });

    expect(currentCorrelationId()).toBeUndefined();
  });

  it('atravessa await, que é o caso de uso real', async () => {
    await runWithCorrelationId('corr-async', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(currentCorrelationId()).toBe('corr-async');
    });
  });

  it('propaga o header na chamada de saída', () => {
    runWithCorrelationId('corr-2', () => {
      expect(correlationHeaders()).toEqual({ [CORRELATION_HEADER]: 'corr-2' });
    });
  });

  it('não inventa id fora de requisição', () => {
    // Um id criado só na chamada de saída não correlaciona com nada e daria
    // falsa impressão de rastro.
    expect(correlationHeaders()).toEqual({});
  });
});
