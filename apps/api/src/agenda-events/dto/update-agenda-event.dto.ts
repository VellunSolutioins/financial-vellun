import { PartialType } from '@nestjs/swagger';

import { CreateAgendaEventDto } from './create-agenda-event.dto';

export class UpdateAgendaEventDto extends PartialType(CreateAgendaEventDto) {}
