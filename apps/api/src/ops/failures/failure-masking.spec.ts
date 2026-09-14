import { maskContent, maskFailurePayload, maskPhone } from './failure-masking';

describe('maskPhone', () => {
  it('preserva DDI/DDD e os dois últimos dígitos', () => {
    // O suficiente para reconhecer o número e confirmar com o cliente, sem que
    // ele apareça inteiro na tela.
    expect(maskPhone('+5541999998877')).toBe('5541*******77');
  });

  it('esconde por completo o que é curto demais para mascarar', () => {
    expect(maskPhone('1234')).toBe('***');
  });

  it('não devolve em claro um número curto que a máscara revelaria inteiro', () => {
    // Preservar quatro dígitos no começo e dois no fim de um valor com seis
    // dígitos não esconde nada.
    expect(maskPhone('123456')).toBe('***');
    expect(maskPhone('123456789')).toBe('***');
    expect(maskPhone('4199998877')).toBe('4199****77');
  });
});

describe('maskContent', () => {
  it('resume em vez de esconder', () => {
    // Esconder tudo tornaria o painel inútil: o começo do texto é o que diz se a
    // falha é de parsing ou de infraestrutura.
    expect(maskContent('gastei 47,50 no mercado')).toBe('gastei 47,50… [23 caracteres]');
  });

  it('não vaza texto curto', () => {
    expect(maskContent('oi')).toBe('[2 caracteres]');
  });
});

describe('maskFailurePayload', () => {
  const inbound = {
    schemaVersion: 1,
    phone: '+5541999998877',
    text: 'gastei 47,50 no mercado',
    providerMessageId: 'wamid.abc',
    kind: 'text',
    correlationId: 'corr-1',
  };

  it('mascara telefone e conteúdo, preservando o resto', () => {
    const resultado = maskFailurePayload(inbound) as Record<string, unknown>;

    expect(resultado.phone).toBe('5541*******77');
    expect(resultado.text).toBe('gastei 47,50… [23 caracteres]');
    // O que não é sensível continua legível: é o que permite diagnosticar.
    expect(resultado.providerMessageId).toBe('wamid.abc');
    expect(resultado.kind).toBe('text');
    expect(resultado.correlationId).toBe('corr-1');
  });

  it('não muta o original', () => {
    // O payload guardado é o que será republicado; alterá-lo aqui corromperia o
    // reprocessamento.
    const copia = { ...inbound };
    maskFailurePayload(copia);

    expect(copia.phone).toBe('+5541999998877');
    expect(copia.text).toBe('gastei 47,50 no mercado');
  });

  it('mascara dentro de estruturas aninhadas e listas', () => {
    const job = {
      jobId: 'job-1',
      phone: '+5541999998877',
      combinedMessage: 'gastei 47,50 no mercado ontem',
      preExtractedIntent: { description: 'Mercado', amount: 47.5 },
      mensagens: [{ text: 'gastei 47,50 no mercado' }],
    };

    const resultado = maskFailurePayload(job) as any;

    expect(resultado.phone).toBe('5541*******77');
    expect(resultado.combinedMessage).toContain('[29 caracteres]');
    expect(resultado.mensagens[0].text).toContain('[23 caracteres]');
    expect(resultado.jobId).toBe('job-1');
  });

  it('mascara o preExtractedIntent do agente, que chega em snake_case', () => {
    // Nenhuma destas chaves estava na lista de bloqueio anterior: valor, conta e
    // descrição do lançamento saíam em claro para quem não pode ver dado sensível.
    const job = {
      jobId: 'job-1',
      attempt: 2,
      forceConfirm: true,
      sourceMessageIds: ['m-1', 'm-2'],
      preExtractedIntent: {
        intent: 'create_transaction',
        transaction_type: 'expense',
        amount: 47.5,
        description: 'Mercado do bairro',
        category_name: 'Alimentação',
        account_name: 'Nubank',
        transaction_date: '2026-09-14',
        confidence: 0.92,
        needs_confirmation: false,
        confirmation_question: null,
      },
    };

    const resultado = maskFailurePayload(job) as any;
    const intent = resultado.preExtractedIntent;

    expect(intent.amount).toBe('[número]');
    expect(intent.description).toBe('[17 caracteres]');
    expect(intent.category_name).toBe('[11 caracteres]');
    expect(intent.account_name).toBe('[6 caracteres]');
    expect(intent.transaction_date).toBe('[10 caracteres]');
    // A classificação continua legível: é o que diz o que o agente entendeu.
    expect(intent.intent).toBe('create_transaction');
    expect(intent.transaction_type).toBe('expense');
    expect(intent.confidence).toBe(0.92);
    expect(intent.needs_confirmation).toBe(false);
    expect(intent.confirmation_question).toBeNull();
    // Estruturais do job seguem intactos, inclusive dentro de listas.
    expect(resultado.attempt).toBe(2);
    expect(resultado.forceConfirm).toBe(true);
    expect(resultado.sourceMessageIds).toEqual(['m-1', 'm-2']);
  });

  it('mascara por padrão um campo que ninguém declarou', () => {
    // Lista de permissão: um campo novo num contrato nasce mascarado, e não
    // vazando até alguém lembrar de adicioná-lo a uma lista de bloqueio.
    const resultado = maskFailurePayload({
      correlationId: 'corr-1',
      pixKey: 'fulano@exemplo.com',
      saldo: 1234.56,
      extra: { cpf: '12345678900', itens: ['arroz', 'feijão'] },
    }) as any;

    expect(resultado.correlationId).toBe('corr-1');
    expect(resultado.pixKey).toBe('[18 caracteres]');
    expect(resultado.saldo).toBe('[número]');
    expect(resultado.extra.cpf).toBe('[11 caracteres]');
    expect(resultado.extra.itens).toEqual(['[5 caracteres]', '[6 caracteres]']);
  });

  it('mascara um payload que não é objeto', () => {
    // Mensagem que nem era JSON chega ao catálogo como texto cru.
    expect(maskFailurePayload('gastei 47,50 no mercado')).toBe('[23 caracteres]');
  });

  it('não estoura com estrutura muito funda', () => {
    let fundo: any = { phone: '+5541999998877' };
    for (let i = 0; i < 20; i++) fundo = { nested: fundo };

    expect(() => maskFailurePayload(fundo)).not.toThrow();
    expect(JSON.stringify(maskFailurePayload(fundo))).toContain('[TRUNCADO]');
  });

  it('cobre as variações de campo de telefone dos contratos', () => {
    const resultado = maskFailurePayload({
      phone: '+5541999998877',
      phoneNumber: '+5541999998877',
      from: '+5541999998877',
      to: '+5541999998877',
    }) as Record<string, string>;

    for (const valor of Object.values(resultado)) {
      expect(valor).toBe('5541*******77');
    }
  });
});
