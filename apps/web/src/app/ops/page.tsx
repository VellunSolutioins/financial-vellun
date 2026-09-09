'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useOpsSession } from '@/contexts/ops-session-context';

/**
 * Resumo da área de operações.
 *
 * Nesta entrega só confirma a identidade e o que ela permite — o painel com
 * métricas, falhas e links para o Grafana é a Entrega 6, e depende do catálogo
 * de falhas existir.
 */
export default function OpsOverviewPage() {
  const { operator } = useOpsSession();
  if (!operator) return null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Sessão de operações</CardTitle>
          <CardDescription>
            Identidade separada da conta do produto, com papel e permissões próprios.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">GitHub</dt>
              <dd className="font-medium">{operator.githubLogin}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Papel</dt>
              <dd className="font-medium">{operator.role}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Dados sensíveis</dt>
              <dd className="font-medium">{operator.canViewSensitive ? 'Sim' : 'Não'}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
