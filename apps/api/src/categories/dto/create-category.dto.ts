import { IsEnum, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { CategoryNature } from '@prisma/client';
import { ENTRY_TYPES, EntryType } from '../../transactions/entry-types';

export class CreateCategoryDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiProperty({ enum: ENTRY_TYPES })
  @IsIn(ENTRY_TYPES)
  type!: EntryType;

  @ApiProperty({ required: false, nullable: true, example: '#3b82f6' })
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'Cor deve estar no formato hex #RRGGBB' })
  color?: string | null;

  @ApiProperty({ required: false, nullable: true, example: '🛒' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  costCenter?: string;

  @ApiProperty({
    enum: CategoryNature,
    required: false,
    default: CategoryNature.consumption,
    description:
      'Natureza do gasto (só em despesa): consumo, aquisição de bens ou juros e tarifas. ' +
      'Os dois últimos aparecem à parte do consumo no dashboard.',
  })
  @IsOptional()
  @IsEnum(CategoryNature)
  nature?: CategoryNature;
}
