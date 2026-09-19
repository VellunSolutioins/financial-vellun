import { AppLoggerService } from './app-logger.service';
import { LokiTransport } from './loki-transport';

/**
 * O envio ao Loki não pode depender do formato do terminal.
 *
 * O bug que este spec fixa: fora de produção o logger escrevia no console e
 * **retornava antes** de chegar ao transporte. O transporte era criado — a
 * variável era lida certo —, mas nunca recebia uma linha, e nada avisava. Só
 * aparecia na configuração local real, com o compose de observabilidade no ar e
 * `NODE_ENV` diferente de `production`.
 */
describe('AppLoggerService', () => {
  const ambienteOriginal = { ...process.env };
  let push: jest.SpyInstance;

  beforeEach(() => {
    push = jest.spyOn(LokiTransport.prototype, 'push').mockImplementation(() => undefined);
    // O console do Nest não interessa a estes testes, só o que vai para o Loki.
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.env = { ...ambienteOriginal };
    jest.restoreAllMocks();
  });

  function logger(env: Record<string, string | undefined>): AppLoggerService {
    process.env = { ...ambienteOriginal, ...env };
    // Os campos são lidos na construção, então o ambiente precisa vir antes.
    return new AppLoggerService();
  }

  it('em desenvolvimento, envia ao Loki quando LOKI_PUSH_URL está definido', () => {
    const log = logger({ NODE_ENV: 'development', LOKI_PUSH_URL: 'http://localhost:3100' });

    log.log('pedido recebido', 'TransactionsController');

    expect(push).toHaveBeenCalledTimes(1);
  });

  it('o que vai ao Loki é JSON, mesmo com o terminal em texto', () => {
    const log = logger({ NODE_ENV: 'development', LOKI_PUSH_URL: 'http://localhost:3100' });

    log.warn('fila crescendo', 'WebhookRetryService');

    const [linha] = push.mock.calls[0] as [string];
    const parsed = JSON.parse(linha);
    // Os campos fixos são o que permite `correlationId="..."` e `level="warn"`
    // como filtro no Loki, em vez de busca por substring.
    expect(parsed).toMatchObject({
      level: 'warn',
      service: 'api',
      env: 'development',
      event: 'WebhookRetryService',
      message: 'fila crescendo',
    });
  });

  it('em produção também envia', () => {
    const log = logger({ NODE_ENV: 'production', LOKI_PUSH_URL: 'http://alloy:3100' });

    log.error('falhou', undefined, 'BillingService');

    expect(push).toHaveBeenCalledTimes(1);
  });

  it('sem LOKI_PUSH_URL não existe transporte, em nenhum ambiente', () => {
    for (const NODE_ENV of ['development', 'production']) {
      push.mockClear();
      const log = logger({ NODE_ENV, LOKI_PUSH_URL: undefined });

      log.log('qualquer coisa', 'Contexto');

      expect(push).not.toHaveBeenCalled();
    }
  });

  it('LOKI_PUSH_URL só com espaços conta como ausente', () => {
    const log = logger({ NODE_ENV: 'development', LOKI_PUSH_URL: '   ' });

    log.log('qualquer coisa', 'Contexto');

    expect(push).not.toHaveBeenCalled();
  });

  it('todos os níveis chegam ao Loki em desenvolvimento', () => {
    const log = logger({ NODE_ENV: 'development', LOKI_PUSH_URL: 'http://localhost:3100' });

    log.log('a', 'C');
    log.warn('b', 'C');
    log.error('c', undefined, 'C');
    log.debug('d', 'C');
    log.verbose('e', 'C');

    const niveis = push.mock.calls.map(([linha]) => JSON.parse(linha as string).level);
    expect(niveis).toEqual(['log', 'warn', 'error', 'debug', 'verbose']);
  });
});
