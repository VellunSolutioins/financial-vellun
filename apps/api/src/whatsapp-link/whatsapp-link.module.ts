import { Module } from '@nestjs/common';

import { PhoneVerificationController } from './phone-verification.controller';
import { WhatsappLinkService } from './whatsapp-link.service';

@Module({
  controllers: [PhoneVerificationController],
  providers: [WhatsappLinkService],
  exports: [WhatsappLinkService],
})
export class WhatsappLinkModule {}
