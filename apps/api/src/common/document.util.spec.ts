import { isValidCnpj, isValidCpf } from './document.util';

describe('isValidCpf', () => {
  it('aceita CPF válido (com e sem máscara)', () => {
    expect(isValidCpf('249.715.637-92')).toBe(true);
    expect(isValidCpf('24971563792')).toBe(true);
  });

  it('rejeita dígito verificador inválido', () => {
    expect(isValidCpf('249.715.637-93')).toBe(false);
  });

  it('rejeita sequência repetida e tamanho incorreto', () => {
    expect(isValidCpf('111.111.111-11')).toBe(false);
    expect(isValidCpf('123')).toBe(false);
  });
});

describe('isValidCnpj', () => {
  it('aceita CNPJ válido (com e sem máscara)', () => {
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11222333000181')).toBe(true);
  });

  it('rejeita dígito verificador inválido', () => {
    expect(isValidCnpj('11.222.333/0001-82')).toBe(false);
  });

  it('rejeita sequência repetida e tamanho incorreto', () => {
    expect(isValidCnpj('11.111.111/1111-11')).toBe(false);
    expect(isValidCnpj('123')).toBe(false);
  });
});
