import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ProfileType, TransactionType } from '@prisma/client';

export class CreateCategoryDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiProperty({ enum: TransactionType })
  @IsEnum(TransactionType)
  type!: TransactionType;

  /** Contexto (Pessoal/Negócio) da categoria — quando ausente, usa o perfil do usuário. */
  @ApiProperty({ enum: ProfileType, required: false })
  @IsOptional()
  @IsEnum(ProfileType)
  profileType?: ProfileType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  icon?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  costCenter?: string;
}
