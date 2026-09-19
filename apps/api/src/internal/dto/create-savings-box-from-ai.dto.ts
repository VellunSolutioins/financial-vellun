import { IsNotEmpty, IsString } from 'class-validator';

import { CreateSavingsBoxDto } from '../../savings-boxes/dto/create-savings-box.dto';

export class CreateSavingsBoxFromAiDto extends CreateSavingsBoxDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;
}
