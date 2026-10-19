import { SubscriptionStatus } from '@prisma/client';

/**
 * Erro de domínio para transição de estado inválida na máquina de estados de
 * assinatura. Mantém a camada de domínio independente de HTTP; controllers
 * mapeiam para a resposta apropriada.
 */
export class InvalidSubscriptionTransitionError extends Error {
  constructor(
    public readonly from: SubscriptionStatus,
    public readonly to: SubscriptionStatus,
  ) {
    super(`Transição de assinatura inválida: ${from} → ${to}`);
    this.name = 'InvalidSubscriptionTransitionError';
  }
}

/**
 * A assinatura mudou de estado entre a leitura e a gravação de uma transição.
 * Quem chamou decidiu com um estado que já não vale; o certo é tentar de novo
 * a partir do estado atual, não gravar por cima.
 */
export class ConcurrentSubscriptionChangeError extends Error {
  constructor(
    public readonly subscriptionId: string,
    public readonly expected: SubscriptionStatus,
  ) {
    super(`Assinatura ${subscriptionId} deixou de estar ${expected} durante a transição`);
    this.name = 'ConcurrentSubscriptionChangeError';
  }
}

/**
 * Cobrança **paga** que não corresponde a nenhuma assinatura local. Tratar como
 * processado esconderia um cliente que pagou e ficou sem acesso; como erro, o
 * evento é retentado (a linha local pode estar chegando) e, se esgotar, aparece
 * no painel de operações.
 */
export class UncorrelatedPaymentEventError extends Error {
  constructor(
    public readonly providerPaymentId: string,
    public readonly providerSubscriptionId: string | null,
  ) {
    super(
      `Cobrança paga ${providerPaymentId} ` +
        `(assinatura do PSP: ${providerSubscriptionId ?? 'nenhuma'}) ` +
        'não corresponde a nenhuma assinatura local',
    );
    this.name = 'UncorrelatedPaymentEventError';
  }
}
