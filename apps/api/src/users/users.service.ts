import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateIndividualProfileDto } from './dto/create-individual-profile.dto';
import { CreateBusinessProfileDto } from './dto/create-business-profile.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { individualProfile: true, businessProfile: true },
    });
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const { passwordHash: _, ...rest } = user;
    return rest;
  }

  async createOrUpdateIndividualProfile(userId: string, dto: CreateIndividualProfileDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException();
    if (user.profileType !== 'individual') throw new ForbiddenException('Usuário não é do tipo individual');

    const existing = await this.prisma.individualProfile.findUnique({ where: { userId } });
    if (existing) {
      return this.prisma.individualProfile.update({
        where: { userId },
        data: { cpf: dto.cpf, birthDate: dto.birthDate ? new Date(dto.birthDate) : undefined },
      });
    }

    const cpfExists = await this.prisma.individualProfile.findUnique({ where: { cpf: dto.cpf } });
    if (cpfExists) throw new ConflictException('CPF já cadastrado');

    return this.prisma.individualProfile.create({
      data: { userId, cpf: dto.cpf, birthDate: dto.birthDate ? new Date(dto.birthDate) : undefined },
    });
  }

  async createOrUpdateBusinessProfile(userId: string, dto: CreateBusinessProfileDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException();
    if (user.profileType !== 'business') throw new ForbiddenException('Usuário não é do tipo business');

    const existing = await this.prisma.businessProfile.findUnique({ where: { userId } });
    if (existing) {
      return this.prisma.businessProfile.update({
        where: { userId },
        data: { companyName: dto.companyName, tradeName: dto.tradeName, cnpj: dto.cnpj },
      });
    }

    const cnpjExists = await this.prisma.businessProfile.findUnique({ where: { cnpj: dto.cnpj } });
    if (cnpjExists) throw new ConflictException('CNPJ já cadastrado');

    return this.prisma.businessProfile.create({
      data: { userId, companyName: dto.companyName, tradeName: dto.tradeName, cnpj: dto.cnpj },
    });
  }

  async updateUser(userId: string, dto: UpdateUserDto) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { name: dto.name },
      select: { id: true, name: true, email: true, profileType: true, createdAt: true, updatedAt: true },
    });
  }
}
