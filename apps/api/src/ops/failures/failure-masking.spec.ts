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
    // Valores numéricos e campos neutros seguem intactos.
    expect(resultado.preExtractedIntent.amount).toBe(47.5);
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
