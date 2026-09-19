import { IsNotEmpty, IsString } from 'class-validator';

import { CreateContributionDto } from '../../savings-boxes/dto/create-contribution.dto';

export class CreateSavingsContributionFromAiDto extends CreateContributionDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @IsString()
  @IsNotEmpty()
  savingsBoxId!: string;
}
