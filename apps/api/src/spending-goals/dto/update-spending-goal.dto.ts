import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsPositive } from 'class-validator';

export class UpdateSpendingGoalDto {
  @ApiProperty({ description: 'Nova meta mensal de gasto para a categoria.' })
  @IsNumber()
  @IsPositive()
  amount!: number;
}
