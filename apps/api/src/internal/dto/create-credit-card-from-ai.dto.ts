import { IsNotEmpty, IsString } from 'class-validator';

import { CreateCreditCardDto } from '../../credit-cards/dto/create-credit-card.dto';

export class CreateCreditCardFromAiDto extends CreateCreditCardDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;
}
