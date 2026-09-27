import { PartialType } from '@nestjs/swagger';

import { CreateCreditCardDto } from './create-credit-card.dto';

/**
 * `closingDay`/`dueDay` só mudam aqui em cartão já configurado; o cartão em
 * configuração pendente é configurado pelo fluxo de setup.
 */
export class UpdateCreditCardDto extends PartialType(CreateCreditCardDto) {}
