import { IsNotEmpty, IsString } from 'class-validator';

import { CreateReminderDto } from '../../reminders/dto/create-reminder.dto';

export class CreateReminderFromAiDto extends CreateReminderDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;
}
