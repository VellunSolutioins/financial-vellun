'use client';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm';
import { useAuth } from '@/contexts/auth-context';
import {
  type Plan,
  type SubscriptionState,
  cancelSubscription,
  createCheckout,
  formatBRL,
  formatDate,
  getPlans,
  getSubscription,
  intervalLabel,
  paymentFailureText,
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
  // Abre a lista de planos fora do caminho normal: para quem saiu do checkout
  // sem pagar (sem esperar a tentativa expirar) e para quem vai regularizar um
  // plano que não é mais oferecido.
  const [choosingAgain, setChoosingAgain] = useState(false);

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
  const showPending = status === 'pending' && !choosingAgain;

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
          onRegularize={() =>
            state!.plan!.isActive ? handleSubscribe(state!.plan!.id) : setChoosingAgain(true)
          }
          onCancel={handleCancel}
        />
      ) : showPending ? (
        <PendingCard
          busy={busy}
          failure={state?.lastPaymentFailure ?? null}
          onRefresh={load}
          onChooseAgain={() => setChoosingAgain(true)}
        />
      ) : (
        <>
          <StatusNotice status={status} failure={state?.lastPaymentFailure ?? null} />
          <PlansList plans={plans} busy={busy} onSubscribe={handleSubscribe} />
        </>
      )}

      {!loading && showManagement && choosingAgain && (
        <>
          <div className="rounded-md border border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-700">
            O seu plano atual não é mais oferecido. Escolha um dos planos abaixo para regularizar.
          </div>
          <PlansList plans={plans} busy={busy} onSubscribe={handleSubscribe} />
        </>
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

/** Por que a tela voltou a oferecer os planos, quando isso não é óbvio. */
function StatusNotice({
  status,
  failure,
}: {
  status: SubscriptionState['status'];
  failure: SubscriptionState['lastPaymentFailure'];
}) {
  if (status === 'expired') {
    return (
      <div className="rounded-md border border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-700">
        A última tentativa de assinatura não foi concluída e nada foi cobrado. Escolha um plano para
        tentar de novo.
      </div>
    );
  }
  if (status === 'unpaid') {
    return (
      <div className="rounded-md border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-900">
        {failure
          ? `${paymentFailureText(failure.reason)} Escolha um plano para tentar de novo, se possível com outro cartão.`
          : 'Não conseguimos confirmar o seu pagamento. Escolha um plano para regularizar e voltar a usar o produto.'}
      </div>
    );
  }
  return null;
}

function ManagementCard({
  state,
  busy,
  onRegularize,
  onCancel,
}: {
  state: SubscriptionState;
  busy: boolean;
  onRegularize: () => void;
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
            Seu último pagamento não foi confirmado. Regularize para manter o acesso
            {state.graceUntil ? ` (garantido até ${formatDate(state.graceUntil)})` : ''}. Você
            informa o cartão de novo e a cobrança anterior é cancelada.
          </div>
        )}
        {state.lastPaymentFailure &&
          (state.status === 'past_due' ? (
            <p className="text-sm text-muted-foreground">
              {paymentFailureText(state.lastPaymentFailure.reason)}
            </p>
          ) : (
            <div className="rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 text-sm text-yellow-900">
              {paymentFailureText(state.lastPaymentFailure.reason)} Confira o cartão com o banco
              antes do próximo vencimento.
            </div>
          ))}
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
          {state.status === 'past_due' && (
            <Button onClick={onRegularize} disabled={busy}>
              Regularizar pagamento
            </Button>
          )}
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

function PendingCard({
  busy,
  failure,
  onRefresh,
  onChooseAgain,
}: {
  busy: boolean;
  failure: SubscriptionState['lastPaymentFailure'];
  onRefresh: () => void;
  onChooseAgain: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {failure ? 'Pagamento não aprovado' : 'Pagamento em processamento'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {failure
            ? `${paymentFailureText(failure.reason)} Você pode escolher o plano de novo e tentar com outro cartão.`
            : 'Estamos aguardando a confirmação do pagamento. Assim que for aprovado, sua assinatura é ativada automaticamente.'}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={onRefresh} disabled={busy}>
            Atualizar status
          </Button>
          <Button variant={failure ? 'default' : 'ghost'} onClick={onChooseAgain} disabled={busy}>
            {failure ? 'Escolher plano de novo' : 'Não paguei, escolher plano'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PlansList({
  plans,
  busy,
  onSubscribe,
}: {
  plans: Plan[];
  busy: boolean;
  onSubscribe: (planId: string) => void;
}) {
  if (plans.length === 0) {
    return <p className="text-muted-foreground">Nenhum plano disponível no momento.</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {plans.map((plan) => (
        <Card key={plan.id} className="flex flex-col">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base">{plan.name}</CardTitle>
              <Badge variant="secondary">{intervalLabel(plan.interval)}</Badge>
            </div>
            {plan.description && (
              <p className="text-xs text-muted-foreground">{plan.description}</p>
            )}
          </CardHeader>
          <CardContent className="flex flex-1 flex-col justify-between gap-4">
            <p className="text-2xl font-bold">
              {formatBRL(plan.price)}
              <span className="text-sm font-normal text-muted-foreground">
                {' '}
                /{plan.interval === 'annual' ? 'ano' : 'mês'}
              </span>
            </p>
            <Button onClick={() => onSubscribe(plan.id)} disabled={busy}>
              Assinar
            </Button>
          </CardContent>
        </Card>
      ))}
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
