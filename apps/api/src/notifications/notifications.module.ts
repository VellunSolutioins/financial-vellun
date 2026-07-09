import { Module } from '@nestjs/common';
import { WelcomeNotificationService } from './welcome-notification.service';

@Module({
  providers: [WelcomeNotificationService],
  exports: [WelcomeNotificationService],
})
export class NotificationsModule {}
