import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../billing/guards/active-subscription.guard';

import { NotesService } from './notes.service';
import { CreateNoteDto } from './dto/create-note.dto';
import { UpdateNoteDto } from './dto/update-note.dto';

@ApiCookieAuth()
@ApiTags('notes')
@UseGuards(JwtAuthGuard, ActiveSubscriptionGuard)
@Controller('notes')
export class NotesController {
  constructor(private notesService: NotesService) {}

  @Get()
  findAll(@Req() req: Request) {
    const user = req.user as any;
    return this.notesService.findAll(user.dataOwnerId);
  }

  @Post()
  create(@Req() req: Request, @Body() dto: CreateNoteDto) {
    const user = req.user as any;
    return this.notesService.create(user.dataOwnerId, dto);
  }

  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateNoteDto) {
    const user = req.user as any;
    return this.notesService.update(user.dataOwnerId, id, dto);
  }

  @Patch(':id/pin')
  togglePin(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.notesService.togglePin(user.dataOwnerId, id);
  }

  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.notesService.remove(user.dataOwnerId, id);
  }
}
