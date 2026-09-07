import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseEnumPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ContactType } from '@prisma/client';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../billing/guards/active-subscription.guard';
import { ContactsService } from './contacts.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';

@ApiCookieAuth()
@ApiTags('contacts')
@UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
@Controller('contacts')
export class ContactsController {
  constructor(private contactsService: ContactsService) {}

  @Get()
  @ApiQuery({ name: 'type', enum: ContactType, required: false })
  findAll(
    @Req() req: Request,
    @Query('type', new ParseEnumPipe(ContactType, { optional: true })) type?: ContactType,
    @Query('search') search?: string,
  ) {
    const user = req.user as any;
    return this.contactsService.findAll(user.dataOwnerId, type, search);
  }

  @Post()
  create(@Req() req: Request, @Body() dto: CreateContactDto) {
    const user = req.user as any;
    return this.contactsService.create(user.dataOwnerId, dto);
  }

  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateContactDto) {
    const user = req.user as any;
    return this.contactsService.update(user.dataOwnerId, id, dto);
  }

  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.contactsService.remove(user.dataOwnerId, id);
  }
}
