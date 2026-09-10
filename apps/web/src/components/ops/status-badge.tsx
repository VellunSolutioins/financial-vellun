import { Badge, type BadgeProps } from '@/components/ui/badge';
import {
  auditResultLabels,
  failureStatusLabels,
  paymentStatusLabels,
  type OpsAuditResult,
  type OpsFailureStatus,
  type WebhookEventStatus,
} from '@/lib/ops-types';

type Variant = BadgeProps['variant'];

/**
 * Cor por estado, em um lugar só.
 *
 * `pending` é `warning` e não `destructive` de propósito: uma falha pendente é
 * trabalho a fazer, não incidente em curso — o vermelho fica reservado para o
 * que já deu errado de forma definitiva.
 */
const failureVariants: Record<OpsFailureStatus, Variant> = {
  pending: 'warning',
  reprocessing: 'secondary',
  reprocessed: 'success',
  discarded: 'outline',
};

const paymentVariants: Record<WebhookEventStatus, Variant> = {
  received: 'secondary',
  processing: 'secondary',
  processed: 'success',
  failed: 'destructive',
};

const auditVariants: Record<OpsAuditResult, Variant> = {
  success: 'success',
  failure: 'destructive',
  denied: 'warning',
};

export function FailureStatusBadge({ status }: { status: OpsFailureStatus }) {
  return <Badge variant={failureVariants[status]}>{failureStatusLabels[status]}</Badge>;
}

export function PaymentStatusBadge({ status }: { status: WebhookEventStatus }) {
  return <Badge variant={paymentVariants[status]}>{paymentStatusLabels[status]}</Badge>;
}

export function AuditResultBadge({ result }: { result: OpsAuditResult }) {
  return <Badge variant={auditVariants[result]}>{auditResultLabels[result]}</Badge>;
}
