import type { FeatureFlags } from '@financial-vellun/shared';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { FeatureFlagsService } from './feature-flags.service';

/**
 * Estado das flags para o app montar o menu e bloquear rotas.
 *
 * Sem `ActiveSubscriptionGuard`: o menu precisa ser montado mesmo para quem
 * está sem assinatura (a tela de assinatura vive dentro do layout do app).
 */
@ApiCookieAuth()
@ApiTags('features')
@UseGuards(JwtAuthGuard)
@Controller('features')
export class FeatureFlagsController {
  constructor(private readonly flags: FeatureFlagsService) {}

  @Get()
  @ApiOkResponse({
    description: 'Mapa chave → disponível. Ex.: `{ "agenda": true, "notes": false }`.',
  })
  getAll(): Promise<FeatureFlags> {
    return this.flags.getAll();
  }
}
