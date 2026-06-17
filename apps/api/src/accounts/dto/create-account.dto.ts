import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';
import { Type } from 'class-transformer';

export class CreateAccountDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiProperty({ enum: AccountType })
  @IsEnum(AccountType)
  type!: AccountType;

  @ApiProperty({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  initialBalance?: number;

  @ApiProperty({ default: 'BRL', required: false })
  @IsOptional()
  @IsString()
  currency?: string;
}
