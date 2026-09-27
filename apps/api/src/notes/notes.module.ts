import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module';

import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';

@Module({
  imports: [BillingModule],
  controllers: [NotesController],
  providers: [NotesService],
  exports: [NotesService],
})
export class NotesModule {}
