import { Module } from '@nestjs/common';

import { PhoneLinkController } from './phone-link.controller';
import { PhoneVerificationController } from './phone-verification.controller';
import { WhatsappLinkService } from './whatsapp-link.service';

@Module({
  controllers: [PhoneVerificationController, PhoneLinkController],
  providers: [WhatsappLinkService],
  exports: [WhatsappLinkService],
})
export class WhatsappLinkModule {}
