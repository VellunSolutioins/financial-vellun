import { PartialType } from '@nestjs/swagger';

import { CreateSavingsBoxDto } from './create-savings-box.dto';

export class UpdateSavingsBoxDto extends PartialType(CreateSavingsBoxDto) {}
