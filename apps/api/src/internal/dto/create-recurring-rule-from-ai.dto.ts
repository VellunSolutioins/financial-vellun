import { IsNotEmpty, IsString } from 'class-validator';

import { CreateRecurringRuleDto } from '../../recurring-rules/dto/create-recurring-rule.dto';

export class CreateRecurringRuleFromAiDto extends CreateRecurringRuleDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;
}
