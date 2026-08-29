import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsPositive, IsUUID } from 'class-validator';

export class CreateSpendingGoalDto {
  @ApiProperty()
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ description: 'Meta mensal de gasto para a categoria, ex.: 1500.00.' })
  @IsNumber()
  @IsPositive()
  amount!: number;
}
