import { Body, Controller, Get, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UsersService } from './users.service';
import { CreateIndividualProfileDto } from './dto/create-individual-profile.dto';
import { CreateBusinessProfileDto } from './dto/create-business-profile.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdatePasswordDto } from './dto/update-password.dto';

@ApiCookieAuth()
@ApiTags('users')
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get('me/profile')
  getProfile(@Req() req: Request) {
    const user = req.user as any;
    return this.usersService.getProfile(user.id);
  }

  @Post('me/profile/individual')
  createIndividualProfile(@Req() req: Request, @Body() dto: CreateIndividualProfileDto) {
    const user = req.user as any;
    return this.usersService.createOrUpdateIndividualProfile(user.id, dto);
  }

  @Post('me/profile/business')
  createBusinessProfile(@Req() req: Request, @Body() dto: CreateBusinessProfileDto) {
    const user = req.user as any;
    return this.usersService.createOrUpdateBusinessProfile(user.id, dto);
  }

  @Patch('me')
  updateUser(@Req() req: Request, @Body() dto: UpdateUserDto) {
    const user = req.user as any;
    return this.usersService.updateUser(user.id, dto);
  }

  @Patch('me/password')
  updatePassword(@Req() req: Request, @Body() dto: UpdatePasswordDto) {
    const user = req.user as any;
    return this.usersService.updatePassword(user.id, dto);
  }
}
