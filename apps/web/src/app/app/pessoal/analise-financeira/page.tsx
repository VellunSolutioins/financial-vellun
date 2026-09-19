'use client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScoreGauge } from '@/components/financial-analysis/ScoreGauge';
import { useFinancialScores } from '@/hooks/useFinancialScores';
import { cn } from '@/lib/utils';

const BAND_STYLES: Record<string, { color: string; badge: string }> = {
  fraco: { color: '#ef4444', badge: 'bg-rose-100 text-rose-700' },
  regular: { color: '#f59e0b', badge: 'bg-amber-100 text-amber-700' },
  bom: { color: '#3b82f6', badge: 'bg-blue-100 text-blue-700' },
  excelente: { color: '#10b981', badge: 'bg-emerald-100 text-emerald-700' },
};

export default function AnaliseFinanceiraPage() {
  const { data, loading, error } = useFinancialScores();

  return (
    <div className="space-y-4 sm:space-y-6">
      <div>
        <h1 className="text-xl font-bold sm:text-2xl">Análise Financeira</h1>
        <p className="text-sm text-muted-foreground">
          7 indicadores calculados a partir dos seus dados reais no sistema.
        </p>
      </div>

      {loading ? (
        <div className="p-10 text-center text-sm text-muted-foreground">Calculando seus scores...</div>
      ) : error ? (
        <Card className="rounded-2xl">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Não foi possível calcular sua análise agora. Tente novamente mais tarde.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((item) => {
            const style = BAND_STYLES[item.band.key] ?? BAND_STYLES.regular;
            return (
              <Card key={item.key} className="rounded-2xl">
                <CardContent className="space-y-4 p-5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium">
                      {item.emoji} {item.title}
                    </p>
                    <Badge className={cn('shrink-0', style.badge)}>{item.band.label}</Badge>
                  </div>

                  <ScoreGauge score={item.score} color={style.color} />

                  <p className="text-center text-xs text-muted-foreground">{item.description}</p>

                  <ul className="space-y-1.5 border-t border-border pt-3 text-xs">
                    {item.indicators.map((ind) => (
                      <li key={ind.label} className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">{ind.label}</span>
                        <span className="font-medium">{ind.value}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
