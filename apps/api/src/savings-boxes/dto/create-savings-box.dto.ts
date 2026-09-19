import { ApiProperty } from '@nestjs/swagger';
import { SavingsYieldPeriod } from '@prisma/client';
import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';

export class CreateSavingsBoxDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiProperty({ required: false, description: 'Meta a alcançar. Omitir = sem alvo, só acumular.' })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  targetAmount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  targetDate?: string;

  @ApiProperty({ required: false, description: 'Percentual do rendimento, ex.: 0.5 (0,5%).' })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  yieldRate?: number;

  @ApiProperty({ enum: SavingsYieldPeriod, required: false })
  @IsOptional()
  @IsIn(Object.values(SavingsYieldPeriod))
  yieldPeriod?: SavingsYieldPeriod;
}
