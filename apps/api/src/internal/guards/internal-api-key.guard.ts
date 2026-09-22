import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

import { safeEqual } from '../../common/crypto.util';
import { AGENT_TO_API_KEY_ENV, acceptedInternalKeys } from '../../common/internal-keys.util';

/**
 * Autentica as chamadas do agente para a API. Aceita a chave da direção
 * agente→API e, durante a migração, a `INTERNAL_API_KEY` antiga.
 */
@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  constructor(private configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers['x-internal-api-key'];
    const accepted = acceptedInternalKeys(this.configService, AGENT_TO_API_KEY_ENV);
    if (accepted.length === 0) {
      throw new Error(`Configure ${AGENT_TO_API_KEY_ENV} (ou INTERNAL_API_KEY)`);
    }

    // Compara com todas, sem parar na primeira: o tempo não revela qual casou.
    const matches =
      typeof provided === 'string' &&
      accepted.map((key) => safeEqual(provided, key)).some((ok) => ok);
    if (!matches) {
      throw new UnauthorizedException('Chave de API interna inválida');
    }

    return true;
  }
}
