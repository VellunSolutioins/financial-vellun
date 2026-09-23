import { Global, Module } from '@nestjs/common';

import { SecurityEventsService } from './security-events.service';

/**
 * Global: a trilha é registrada de vários módulos (conta, vínculo do WhatsApp,
 * sessões) e não faz sentido cada um redeclarar a dependência.
 */
@Global()
@Module({
  providers: [SecurityEventsService],
  exports: [SecurityEventsService],
})
export class SecurityEventsModule {}
