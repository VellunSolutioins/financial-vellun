import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TransactionsService } from './transactions.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { ListTransactionsDto } from './dto/list-transactions.dto';

@ApiCookieAuth()
@ApiTags('transactions')
@UseGuards(JwtAuthGuard)
@Controller('transactions')
export class TransactionsController {
  constructor(private transactionsService: TransactionsService) {}

  @Get()
  findAll(@Req() req: Request, @Query() filters: ListTransactionsDto) {
    const user = req.user as any;
    return this.transactionsService.findAll(user.id, filters);
  }

  @Get(':id')
  findOne(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.transactionsService.findOne(user.id, id);
  }

  @Post()
  create(@Req() req: Request, @Body() dto: CreateTransactionDto) {
    const user = req.user as any;
    return this.transactionsService.create(user.id, dto);
  }

  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateTransactionDto) {
    const user = req.user as any;
    return this.transactionsService.update(user.id, id, dto);
  }

  @Delete(':id')
  remove(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('hard_delete') hardDelete?: string,
  ) {
    const user = req.user as any;
    return this.transactionsService.remove(user.id, id, hardDelete === 'true');
  }
}
