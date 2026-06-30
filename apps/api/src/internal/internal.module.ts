import { Module } from '@nestjs/common';
import { InternalController } from './controllers/internal.controller';
import { InternalService } from './internal.service';
import { AccountsModule } from '../accounts/accounts.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [AccountsModule, BillingModule],
  controllers: [InternalController],
  providers: [InternalService],
})
export class InternalModule {}
