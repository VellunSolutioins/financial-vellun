import { ForbiddenException } from '@nestjs/common';

/** Código de erro para funcionalidade desligada pelo /ops. O web redireciona ao vê-lo. */
export const FEATURE_DISABLED = 'FEATURE_DISABLED';

/** Resposta 403 padrão quando a rota pertence a uma funcionalidade desligada. */
export class FeatureDisabledException extends ForbiddenException {
  constructor(message = 'Esta funcionalidade não está disponível no momento.') {
    super({ statusCode: 403, code: FEATURE_DISABLED, message });
  }
}
