import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module';

import { SavingsBoxesController } from './savings-boxes.controller';
import { SavingsBoxesService } from './savings-boxes.service';

@Module({
  imports: [BillingModule],
  controllers: [SavingsBoxesController],
  providers: [SavingsBoxesService],
})
export class SavingsBoxesModule {}
