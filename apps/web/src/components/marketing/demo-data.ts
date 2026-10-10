/**
 * Dados fictícios das demonstrações das páginas públicas. Nada aqui vem da API
 * nem toca em estado financeiro de usuário: são textos e números fixos.
 */

const DEMO_DATE = '10/10/2026';
const DEMO_ACCOUNT = 'Conta Principal';

export const demoChat = {
  userMessage: 'Gastei R$ 85 no mercado',
  /** Mesmo formato de `TransactionCreator._success_message` (apps/ai-agent). */
  botReply: `Lançamento criado! Despesa de R$ 85,00 em Mercado, na conta ${DEMO_ACCOUNT}, em ${DEMO_DATE}.`,
  time: '09:41',
};

export const demoEntry = {
  description: 'Mercado',
  category: 'Mercado',
  categoryColor: '#FFA07A',
  account: DEMO_ACCOUNT,
  date: DEMO_DATE,
  amount: 85,
};

/** Gastos do mês por categoria; o de Mercado já inclui o lançamento acima. */
export const demoCategories = [
  { name: 'Moradia', total: 800, color: '#87CEEB' },
  { name: 'Mercado', total: 385, color: '#FFA07A' },
  { name: 'Transporte', total: 165, color: '#98FB98' },
];

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const percent = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function formatDemoCurrency(value: number): string {
  return currency.format(value);
}

export function formatDemoPercent(value: number): string {
  return `${percent.format(value)}%`;
}
