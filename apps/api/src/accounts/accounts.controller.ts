import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../billing/guards/active-subscription.guard';
import { AccountsService } from './accounts.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';

@ApiCookieAuth()
@ApiTags('accounts')
@UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
@Controller('accounts')
export class AccountsController {
  constructor(private accountsService: AccountsService) {}

  @Get()
  findAll(@Req() req: Request) {
    const user = req.user as any;
    return this.accountsService.findAll(user.dataOwnerId);
  }

  @Get(':id')
  findOne(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.accountsService.findOne(user.dataOwnerId, id);
  }

  @Post()
  create(@Req() req: Request, @Body() dto: CreateAccountDto) {
    const user = req.user as any;
    return this.accountsService.create(user.dataOwnerId, dto);
  }

  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateAccountDto) {
    const user = req.user as any;
    return this.accountsService.update(user.dataOwnerId, id, dto);
  }

  @Delete(':id')
  deactivate(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.accountsService.deactivate(user.dataOwnerId, id);
  }
}
