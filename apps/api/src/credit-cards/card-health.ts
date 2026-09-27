/** Selos de comprometimento do limite (só aplicável quando há creditLimit). */
const HEALTH_BANDS = [
  {
    max: 20,
    key: 'tranquilo',
    emoji: '🟢',
    label: 'Tranquilo',
    message: 'Você está usando pouco do seu limite.',
  },
  {
    max: 40,
    key: 'saudavel',
    emoji: '🔵',
    label: 'Saudável',
    message: 'Boa margem disponível para seus gastos.',
  },
  {
    max: 60,
    key: 'atencao',
    emoji: '🟡',
    label: 'Atenção',
    message: 'Seu limite já está parcialmente comprometido.',
  },
  {
    max: 80,
    key: 'apertado',
    emoji: '🟠',
    label: 'Apertado',
    message: 'Fique de olho nos próximos gastos.',
  },
  {
    max: 99,
    key: 'no_limite',
    emoji: '🔴',
    label: 'No Limite',
    message: 'Seu limite está quase comprometido.',
  },
] as const;

export function healthFromPercentage(percentage: number): {
  key: string;
  emoji: string;
  label: string;
  message: string;
} {
  for (const band of HEALTH_BANDS) {
    if (percentage <= band.max) return band;
  }
  return {
    key: 'limite_atingido',
    emoji: '🚨',
    label: 'Limite Atingido',
    message: 'Seu limite foi alcançado. Evite novos gastos até liberar crédito.',
  };
}

/** Selos de comprometimento da fatura total em relação à renda mensal dos lançamentos fixos. */
const INCOME_HEALTH_BANDS = [
  { max: 10, key: 'excelente', emoji: '🟢', label: 'Excelente' },
  { max: 20, key: 'saudavel', emoji: '🔵', label: 'Saudável' },
  { max: 30, key: 'atencao', emoji: '🟡', label: 'Atenção' },
  { max: 40, key: 'apertado', emoji: '🟠', label: 'Apertado' },
  { max: 50, key: 'critico', emoji: '🔴', label: 'Crítico' },
] as const;

export function incomeHealthFromPercentage(percentage: number): {
  key: string;
  emoji: string;
  label: string;
} {
  for (const band of INCOME_HEALTH_BANDS) {
    if (percentage <= band.max) return band;
  }
  return { key: 'muito_alto', emoji: '🚨', label: 'Muito Alto' };
}
