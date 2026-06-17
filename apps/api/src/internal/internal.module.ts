import { Module } from '@nestjs/common';
import { InternalController } from './controllers/internal.controller';
import { InternalService } from './internal.service';
import { AccountsModule } from '../accounts/accounts.module';

@Module({
  imports: [AccountsModule],
  controllers: [InternalController],
  providers: [InternalService],
})
export class InternalModule {}
