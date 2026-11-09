import { withoutShadowedDefaults } from './default-categories';

describe('withoutShadowedDefaults', () => {
  const standard = (name: string, type = 'expense') => ({
    name,
    type,
    isDefault: true,
    userId: null,
  });
  const own = (name: string, type = 'expense') => ({
    name,
    type,
    isDefault: false,
    userId: 'u1',
  });

  it('esconde a categoria padrão que o usuário já tem como dele, sem olhar acento nem caixa', () => {
    const list = [standard('Streaming'), standard('Educação'), own('streaming'), own('EDUCACAO')];
    expect(withoutShadowedDefaults(list).map((c) => c.name)).toEqual(['streaming', 'EDUCACAO']);
  });

  it('mantém a padrão quando o nome igual é de outro tipo ou não existe', () => {
    const list = [standard('Vendas'), standard('Mercado'), own('Vendas', 'income')];
    expect(withoutShadowedDefaults(list).map((c) => [c.name, c.type])).toEqual([
      ['Vendas', 'expense'],
      ['Mercado', 'expense'],
      ['Vendas', 'income'],
    ]);
  });
});
