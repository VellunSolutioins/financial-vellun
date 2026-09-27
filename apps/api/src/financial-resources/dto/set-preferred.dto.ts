import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/** Um dos dois, ou nenhum para ficar sem preferência. */
export class SetPreferredDto {
  @ApiProperty({ required: false, description: 'Conta comum ativa.' })
  @IsOptional()
  @IsString()
  accountId?: string;

  @ApiProperty({ required: false, description: 'Cartão não arquivado (id do cartão).' })
  @IsOptional()
  @IsString()
  cardId?: string;
}
