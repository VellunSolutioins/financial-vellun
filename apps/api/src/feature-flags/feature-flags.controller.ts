import type { FeatureFlags } from '@financial-vellun/shared';
import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { FeatureFlagsService } from './feature-flags.service';

/**
 * Estado das flags para o app montar o menu e bloquear rotas.
 *
 * Sem `ActiveSubscriptionGuard`: o menu precisa ser montado mesmo para quem
 * está sem assinatura (a tela de assinatura vive dentro do layout do app).
 */
@ApiTags('features')
@Controller('features')
export class FeatureFlagsController {
  constructor(private readonly flags: FeatureFlagsService) {}

  @Get()
  @ApiCookieAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOkResponse({
    description: 'Mapa chave → disponível. Ex.: `{ "agenda": true, "notes": false }`.',
  })
  getAll(): Promise<FeatureFlags> {
    return this.flags.getAll();
  }

  /**
   * Parte do mapa, sem sessão: a home pública ajusta textos ao que está ligado
   * (ex.: o FAQ cita a correção pelo WhatsApp só com `whatsapp_edit`). Devolve
   * só `PUBLIC_FEATURE_KEYS`, para não expor recursos ainda não lançados.
   *
   * Quem consome é o servidor do Next, que já guarda a resposta por 5 min; o
   * limite apertado e o `Cache-Control` seguram quem chama a API direto.
   */
  @Get('public')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOkResponse({
    description:
      'Flags usadas pelas páginas públicas, sem login. Ex.: `{ "whatsapp_edit": true }`.',
  })
  getPublic(): Promise<Partial<FeatureFlags>> {
    return this.flags.getPublic();
  }
}
