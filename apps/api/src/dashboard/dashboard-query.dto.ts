import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional, Matches } from 'class-validator';

import { ResourceFilterDto } from '../common/resource-scope';

/** Período (ou mês) e recorte por conta/cartão; sem recorte = consolidado. */
export class DashboardQueryDto extends ResourceFilterDto {
  @ApiProperty({ required: false, description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  period_start?: string;

  @ApiProperty({ required: false, description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  period_end?: string;

  @ApiProperty({ required: false, description: 'YYYY-MM (série diária)' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}$/)
  month?: string;
}
