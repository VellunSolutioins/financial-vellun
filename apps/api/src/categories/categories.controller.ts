import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@ApiCookieAuth()
@ApiTags('categories')
@UseGuards(JwtAuthGuard)
@Controller('categories')
export class CategoriesController {
  constructor(private categoriesService: CategoriesService) {}

  @Get()
  findAll(@Req() req: Request) {
    const user = req.user as any;
    return this.categoriesService.findAll(user.id, user.profileType);
  }

  @Post()
  create(@Req() req: Request, @Body() dto: CreateCategoryDto) {
    const user = req.user as any;
    return this.categoriesService.create(user.id, user.profileType, dto);
  }

  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    const user = req.user as any;
    return this.categoriesService.update(user.id, id, dto);
  }

  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as any;
    return this.categoriesService.remove(user.id, id);
  }
}
