'use client';
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm';
import { useAuth } from '@/contexts/auth-context';
import { ApiClientError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import {
  type Plan,
  type SubscriptionState,
  cancelSubscription,
  createCheckout,
  createPaymentMethodSession,
  formatBRL,
  formatDate,
  getPlans,
  getSubscription,
  intervalLabel,
  statusMeta,
} from '@/lib/billing';

type ReturnStatus = 'success' | 'cancel' | 'required' | null;

const MANAGED_STATUSES = ['active', 'trialing', 'past_due'];

export default function AssinaturaPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const { refreshSubscriptionAccess } = useAuth();

  const [state, setState] = useState<SubscriptionState | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [returnStatus, setReturnStatus] = useState<ReturnStatus>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sub, planList] = await Promise.all([getSubscription(), getPlans()]);
      setState(sub);
      setPlans(planList);
      void refreshSubscriptionAccess();
    } catch {
      toast.error('Não foi possível carregar sua assinatura.');
    } finally {
      setLoading(false);
    }
  }, [toast, refreshSubscriptionAccess]);

  useEffect(() => {
    // Lê o retorno do checkout sem useSearchParams (evita Suspense no build).
    const params = new URLSearchParams(window.location.search);
    setReturnStatus((params.get('status') as ReturnStatus) ?? null);
    void load();
  }, [load]);

  const handleSubscribe = async (planId: string) => {
    setBusy(true);
    try {
      const { checkoutUrl } = await createCheckout(planId);
      window.location.assign(checkoutUrl);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não foi possível iniciar o checkout.');
      setBusy(false);
    }
  };

  const handleUpdateCard = async () => {
    setBusy(true);
    try {
      const { url } = await createPaymentMethodSession();
      window.location.assign(url);
    } catch (e) {
      if (e instanceof ApiClientError && e.statusCode === 501) {
        toast.error('Atualização de cartão indisponível no momento.');
      } else {
        toast.error(e instanceof Error ? e.message : 'Não foi possível atualizar o cartão.');
      }
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    const ok = await confirm({
      title: 'Cancelar assinatura',
      description:
        'Você continuará com acesso até o fim do período já pago. Deseja realmente cancelar?',
      confirmText: 'Cancelar assinatura',
      cancelText: 'Voltar',
      variant: 'destructive',
    });
    if (!ok) return;

    setBusy(true);
    try {
      const updated = await cancelSubscription();
      setState(updated);
      void refreshSubscriptionAccess();
      toast.success('Cancelamento agendado para o fim do período.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não foi possível cancelar.');
    } finally {
      setBusy(false);
    }
  };

  const status = state?.status ?? null;
  const showManagement = !!state?.plan && !!status && MANAGED_STATUSES.includes(status);
  const showPending = status === 'pending';

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Assinatura</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Gerencie seu plano, pagamento e período de cobrança.
        </p>
      </div>

      <ReturnNotice status={returnStatus} />

      {loading ? (
        <p className="text-muted-foreground">Carregando...</p>
      ) : showManagement ? (
        <ManagementCard
          state={state!}
          busy={busy}
          onUpdateCard={handleUpdateCard}
          onCancel={handleCancel}
        />
      ) : showPending ? (
        <PendingCard busy={busy} onRefresh={load} />
      ) : (
        <PlansList plans={plans} busy={busy} onSubscribe={handleSubscribe} />
      )}
    </div>
  );
}

function ReturnNotice({ status }: { status: ReturnStatus }) {
  if (status === 'success') {
    return (
      <div className="rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-900">
        Recebemos seu checkout. A ativação ocorre <strong>após a confirmação do pagamento</strong> e
        pode levar alguns instantes.
      </div>
    );
  }
  if (status === 'cancel') {
    return (
      <div className="rounded-md border border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-700">
        Checkout não concluído. Você pode tentar novamente quando quiser.
      </div>
    );
  }
  if (status === 'required') {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
        É necessária uma assinatura ativa para usar o produto.
      </div>
    );
  }
  return null;
}

function ManagementCard({
  state,
  busy,
  onUpdateCard,
  onCancel,
}: {
  state: SubscriptionState;
  busy: boolean;
  onUpdateCard: () => void;
  onCancel: () => void;
}) {
  const meta = statusMeta(state.status);
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">{state.plan?.name ?? 'Plano'}</CardTitle>
          <Badge variant={meta.variant}>{meta.label}</Badge>
        </div>
        {state.plan && (
          <p className="text-xs text-muted-foreground">
            {formatBRL(state.plan.price)} · {intervalLabel(state.plan.interval)}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {state.status === 'past_due' && (
          <div className="rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 text-sm text-yellow-900">
            Seu último pagamento não foi confirmado. Atualize o cartão para manter o acesso
            {state.graceUntil ? ` (acesso garantido até ${formatDate(state.graceUntil)})` : ''}.
          </div>
        )}
        {state.cancelAtPeriodEnd && (
          <div className="rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-700">
            Cancelamento programado. Seu acesso continua até {formatDate(state.currentPeriodEnd)}.
          </div>
        )}

        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
          {state.status === 'trialing' && (
            <Field label="Teste até" value={formatDate(state.trialEndsAt)} />
          )}
          <Field label="Próxima cobrança" value={formatDate(state.currentPeriodEnd)} />
        </dl>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={onUpdateCard} disabled={busy}>
            Atualizar cartão
          </Button>
          {!state.cancelAtPeriodEnd && (
            <Button variant="destructive" onClick={onCancel} disabled={busy}>
              Cancelar assinatura
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function PendingCard({ busy, onRefresh }: { busy: boolean; onRefresh: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pagamento em processamento</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Estamos aguardando a confirmação do pagamento. Assim que for aprovado, sua assinatura é
          ativada automaticamente.
        </p>
        <Button variant="outline" onClick={onRefresh} disabled={busy}>
          Atualizar status
        </Button>
      </CardContent>
    </Card>
  );
}

const FEATURE_LABELS: Record<string, string> = {
  ai: 'Categorização e insights com IA',
  web: 'Acesso completo pela web',
  whatsapp: 'Lançamentos e lembretes pelo WhatsApp',
};

function PlansList({
  plans,
  busy,
  onSubscribe,
}: {
  plans: Plan[];
  busy: boolean;
  onSubscribe: (planId: string) => void;
}) {
  const [billingInterval, setBillingInterval] = useState<'monthly' | 'annual'>('monthly');

  if (plans.length === 0) {
    return <p className="text-muted-foreground">Nenhum plano disponível no momento.</p>;
  }

  // Agrupa por nome (Individual/Duo/Family/Business), guardando a versão
  // mensal e anual de cada — o toggle troca qual versão aparece nos cards.
  const tiers = new Map<string, { monthly?: Plan; annual?: Plan }>();
  for (const plan of plans) {
    const entry = tiers.get(plan.name) ?? {};
    if (plan.interval === 'annual') entry.annual = plan;
    else entry.monthly = plan;
    tiers.set(plan.name, entry);
  }
  const tierList = [...tiers.values()];

  const anyMonthly = tierList.find((t) => t.monthly)?.monthly;
  const anyAnnual = tierList.find((t) => t.annual)?.annual;
  const savingsPct =
    anyMonthly && anyAnnual
      ? Math.round((1 - Number(anyAnnual.price) / (Number(anyMonthly.price) * 12)) * 100)
      : null;

  return (
    <div className="space-y-6">
      {anyMonthly && anyAnnual && (
        <div className="flex justify-center">
          <div className="inline-flex items-center rounded-full border bg-muted p-1">
            {(['monthly', 'annual'] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setBillingInterval(opt)}
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                  billingInterval === opt
                    ? 'bg-primary text-primary-foreground shadow'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {intervalLabel(opt)}
                {opt === 'annual' && savingsPct !== null && savingsPct > 0 && (
                  <span
                    className={cn(
                      'rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                      billingInterval === 'annual'
                        ? 'bg-white/20'
                        : 'bg-emerald-100 text-emerald-700',
                    )}
                  >
                    -{savingsPct}%
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tierList.map(({ monthly, annual }) => {
          const plan = billingInterval === 'annual' ? (annual ?? monthly) : (monthly ?? annual);
          if (!plan) return null;
          const features = plan.features
            ? Object.entries(plan.features)
                .filter(([, enabled]) => enabled)
                .map(([key]) => FEATURE_LABELS[key] ?? key)
            : [];
          return (
            <Card key={plan.name} className="flex flex-col rounded-2xl">
              <CardHeader className="text-center">
                <CardTitle className="text-lg">{plan.name}</CardTitle>
                {plan.description && (
                  <p className="text-xs text-muted-foreground">{plan.description}</p>
                )}
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-4">
                <div className="text-center">
                  <span className="text-3xl font-bold">{formatBRL(plan.price)}</span>
                  <span className="text-sm text-muted-foreground">
                    {' '}
                    /{plan.interval === 'annual' ? 'ano' : 'mês'}
                  </span>
                </div>
                <Button onClick={() => onSubscribe(plan.id)} disabled={busy} className="w-full">
                  Assinar
                </Button>
                {features.length > 0 && (
                  <ul className="space-y-2 text-sm">
                    {features.map((label) => (
                      <li key={label} className="flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                        {label}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
