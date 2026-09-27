import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsInt, Max, Min } from 'class-validator';

/** Configuração de um cartão em configuração pendente (legado). */
export class SetupCreditCardDto {
  @ApiProperty({ minimum: 1, maximum: 31, description: 'Dia do fechamento da fatura.' })
  @IsInt()
  @Min(1)
  @Max(31)
  closingDay!: number;

  @ApiProperty({ minimum: 1, maximum: 31, description: 'Dia do vencimento da fatura.' })
  @IsInt()
  @Min(1)
  @Max(31)
  dueDay!: number;

  @ApiProperty({
    description:
      'YYYY-MM-DD. A partir desta data os lançamentos do cartão contam como dívida e entram em ' +
      'faturas; os anteriores ficam como quitados antes do controle. Não pode ser futura.',
  })
  @IsDateString()
  invoiceTrackingStart!: string;
}
