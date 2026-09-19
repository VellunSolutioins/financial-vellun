import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { BillingModule } from '../billing/billing.module';

import { MembersService } from './members.service';
import { MembersController } from './members.controller';

@Module({
  imports: [BillingModule, JwtModule.register({})],
  controllers: [MembersController],
  providers: [MembersService],
  exports: [MembersService],
})
export class MembersModule {}
