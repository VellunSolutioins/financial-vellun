import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { CreateIndividualProfileDto } from './dto/create-individual-profile.dto';
import { CreateBusinessProfileDto } from './dto/create-business-profile.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdatePasswordDto } from './dto/update-password.dto';
import { normalizeEmail } from '../common/email.util';
import { SessionService } from '../auth/session.service';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private sessions: SessionService,
  ) {}

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
    if (user.profileType !== 'individual')
      throw new ForbiddenException('Usuário não é do tipo individual');

    const cpfOwner = await this.prisma.individualProfile.findUnique({ where: { cpf: dto.cpf } });
    if (cpfOwner && cpfOwner.userId !== userId) throw new ConflictException('CPF já cadastrado');

    const existing = await this.prisma.individualProfile.findUnique({ where: { userId } });
    if (existing) {
      return this.prisma.individualProfile.update({
        where: { userId },
        data: { cpf: dto.cpf, birthDate: dto.birthDate ? new Date(dto.birthDate) : undefined },
      });
    }

    return this.prisma.individualProfile.create({
      data: {
        userId,
        cpf: dto.cpf,
        birthDate: dto.birthDate ? new Date(dto.birthDate) : undefined,
      },
    });
  }

  async createOrUpdateBusinessProfile(userId: string, dto: CreateBusinessProfileDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException();
    if (user.profileType !== 'business')
      throw new ForbiddenException('Usuário não é do tipo business');

    const cnpjOwner = await this.prisma.businessProfile.findUnique({ where: { cnpj: dto.cnpj } });
    if (cnpjOwner && cnpjOwner.userId !== userId) throw new ConflictException('CNPJ já cadastrado');

    const existing = await this.prisma.businessProfile.findUnique({ where: { userId } });
    if (existing) {
      return this.prisma.businessProfile.update({
        where: { userId },
        data: { companyName: dto.companyName, tradeName: dto.tradeName, cnpj: dto.cnpj },
      });
    }

    return this.prisma.businessProfile.create({
      data: { userId, companyName: dto.companyName, tradeName: dto.tradeName, cnpj: dto.cnpj },
    });
  }

  /**
   * Troca a senha e encerra as demais sessões do usuário: quem tinha um token
   * roubado perde o acesso. A sessão que fez a troca continua ativa.
   */
  async updatePassword(userId: string, currentSessionId: string, dto: UpdatePasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const valid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Senha atual incorreta');

    const passwordHash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    await this.sessions.revokeAllForUser(userId, currentSessionId);

    return { message: 'Senha atualizada com sucesso' };
  }

  /**
   * Atualiza os dados da conta. Trocar o e-mail exige a senha atual. O
   * telefone não muda por aqui: ele só é gravado quando o número novo é
   * verificado (`/users/me/phone/verification`).
   */
  async updateUser(userId: string, dto: UpdateUserDto) {
    const email = dto.email !== undefined ? normalizeEmail(dto.email) : undefined;

    if (email !== undefined) {
      const current = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!current) throw new NotFoundException('Usuário não encontrado');

      if (email !== normalizeEmail(current.email)) {
        const valid =
          !!dto.currentPassword &&
          (await bcrypt.compare(dto.currentPassword, current.passwordHash));
        if (!valid) throw new UnauthorizedException('Senha atual incorreta');

        const emailOwner = await this.prisma.user.findFirst({
          where: { email: { equals: email, mode: 'insensitive' }, id: { not: userId } },
        });
        if (emailOwner) throw new ConflictException('Email já cadastrado');
      }
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: {
        name: dto.name,
        email,
        postalCode: dto.postalCode,
        street: dto.street,
        addressNumber: dto.addressNumber,
        complement: dto.complement,
        neighborhood: dto.neighborhood,
        city: dto.city,
        state: dto.state,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        profileType: true,
        postalCode: true,
        street: true,
        addressNumber: true,
        complement: true,
        neighborhood: true,
        city: true,
        state: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }
}
