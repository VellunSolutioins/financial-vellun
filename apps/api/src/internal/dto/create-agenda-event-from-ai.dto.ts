import { IsNotEmpty, IsString } from 'class-validator';

import { CreateAgendaEventDto } from '../../agenda-events/dto/create-agenda-event.dto';

export class CreateAgendaEventFromAiDto extends CreateAgendaEventDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;
}
