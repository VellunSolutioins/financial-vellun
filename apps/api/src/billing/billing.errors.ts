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
