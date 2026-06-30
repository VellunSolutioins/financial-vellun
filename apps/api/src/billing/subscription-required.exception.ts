import { ForbiddenException } from '@nestjs/common';

/** Código de erro padronizado para ausência de assinatura ativa (doc seção 5). */
export const SUBSCRIPTION_REQUIRED = 'SUBSCRIPTION_REQUIRED';

/** Resposta 403 padrão quando o usuário não tem direito de uso do produto. */
export class SubscriptionRequiredException extends ForbiddenException {
  constructor(message = 'É necessária uma assinatura ativa.') {
    super({ statusCode: 403, code: SUBSCRIPTION_REQUIRED, message });
  }
}
