import { PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

import { CreateRecurringRuleDto } from './create-recurring-rule.dto';

export class UpdateRecurringRuleDto extends PartialType(CreateRecurringRuleDto) {
  @ApiProperty({ required: false, description: 'false = Pausada (não gera novos lançamentos).' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
