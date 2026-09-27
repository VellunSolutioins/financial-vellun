import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Alterações aplicadas a todas as parcelas da compra. */
export class UpdateInstallmentDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  description?: string;

  @ApiProperty({ required: false, description: 'Vazio remove a categoria' })
  @IsOptional()
  @IsString()
  categoryId?: string;
}

export class DeleteInstallmentQueryDto {
  @ApiProperty({
    enum: ['all', 'future'],
    default: 'all',
    required: false,
    description: '`all`: a compra inteira; `future`: as parcelas de hoje em diante.',
  })
  @IsOptional()
  @IsIn(['all', 'future'])
  scope?: 'all' | 'future' = 'all';
}
