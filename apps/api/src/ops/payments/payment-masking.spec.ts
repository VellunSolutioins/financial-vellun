import { maskDocument, maskEmail, maskName, maskPaymentPayload } from './payment-masking';

describe('máscaras do payload de pagamento', () => {
  describe('maskEmail', () => {
    it('preserva a inicial e o domínio: reconhece sem revelar', () => {
      expect(maskEmail('bruno@vellun.com.br')).toBe('b****@vellun.com.br');
    });

    it('não devolve nada aproveitável quando não é e-mail', () => {
      expect(maskEmail('sem-arroba')).toBe('***');
      expect(maskEmail('@dominio.com')).toBe('***');
    });
  });

  describe('maskDocument', () => {
    it('deixa só os dois últimos dígitos, o bastante para conferir', () => {
      expect(maskDocument('123.456.789-01')).toBe('*********01');
    });

    it('esconde por completo o que é curto demais para mascarar', () => {
      expect(maskDocument('12')).toBe('***');
    });
  });

  describe('maskName', () => {
    it('mantém o primeiro nome e reduz o resto a iniciais', () => {
      expect(maskName('Bruno Faboci Silva')).toBe('Bruno F. S.');
    });

    it('devolve o nome único inteiro — não há sobrenome a esconder', () => {
      expect(maskName('Bruno')).toBe('Bruno');
    });
  });

  describe('maskPaymentPayload', () => {
    const payload = {
      event: 'PAYMENT_RECEIVED',
      payment: {
        id: 'pay_123',
        value: 49.9,
        creditCard: '[REDACTED]',
        customer: {
          name: 'Bruno Faboci',
          email: 'bruno@vellun.com.br',
          cpfCnpj: '12345678901',
          mobilePhone: '+5541999998877',
        },
      },
    };

    it('mascara identidade e preserva o que serve ao diagnóstico', () => {
      const mascarado = maskPaymentPayload(payload) as any;

      expect(mascarado.payment.customer).toEqual({
        name: 'Bruno F.',
        email: 'b****@vellun.com.br',
        cpfCnpj: '*********01',
        mobilePhone: '5541*******77',
      });
      // O que responde "por que este webhook falhou" continua inteiro.
      expect(mascarado.event).toBe('PAYMENT_RECEIVED');
      expect(mascarado.payment.id).toBe('pay_123');
      expect(mascarado.payment.value).toBe(49.9);
    });

    it('não muta o original — o payload guardado é o registro do evento', () => {
      const copia = JSON.parse(JSON.stringify(payload));

      maskPaymentPayload(payload);

      expect(payload).toEqual(copia);
    });

    it('atravessa listas', () => {
      const mascarado = maskPaymentPayload({
        items: [{ email: 'primeiro@vellun.com' }, { email: 'segundo@vellun.com' }],
      }) as any;

      expect(mascarado.items).toEqual([
        { email: 'p*******@vellun.com' },
        { email: 's******@vellun.com' },
      ]);
    });

    it('trunca em vez de recursar sem fim numa estrutura muito funda', () => {
      let fundo: unknown = { email: 'bruno@vellun.com.br' };
      for (let i = 0; i < 12; i += 1) fundo = { nivel: fundo };

      expect(JSON.stringify(maskPaymentPayload(fundo))).toContain('[TRUNCADO]');
    });
  });
});
