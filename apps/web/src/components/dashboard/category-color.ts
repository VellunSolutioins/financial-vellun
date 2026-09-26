const PALETTE = ['#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#ef4444', '#14b8a6'];
const UNCATEGORIZED_COLOR = '#94a3b8';

/**
 * Cor da categoria: a cadastrada, senão uma da paleta escolhida pelo id. Assim
 * a mesma categoria tem a mesma cor em todos os gráficos da tela — pela
 * posição na lista, "Mercado" seria verde num gráfico e azul no outro.
 */
export function categoryColor(categoryId: string | null, color?: string | null): string {
  if (color) return color;
  if (!categoryId) return UNCATEGORIZED_COLOR;
  let hash = 0;
  for (const char of categoryId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

export interface CategorySlice {
  categoryId: string | null;
  categoryName: string;
  color?: string | null;
  total: number;
}
