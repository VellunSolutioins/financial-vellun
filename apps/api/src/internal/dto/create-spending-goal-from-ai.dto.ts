import { IsNotEmpty, IsString } from 'class-validator';

import { CreateSpendingGoalDto } from '../../spending-goals/dto/create-spending-goal.dto';

export class CreateSpendingGoalFromAiDto extends CreateSpendingGoalDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;
}
