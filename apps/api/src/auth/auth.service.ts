import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AccountType, ProfileType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { normalizePhone } from '../common/phone.util';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private config: ConfigService,
  ) {}

  async register(dto: RegisterDto) {
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (exists) throw new ConflictException('Email já cadastrado');

    const phoneNumber = normalizePhone(dto.phone);
    const phoneExists = await this.prisma.whatsappContact.findUnique({ where: { phoneNumber } });
    if (phoneExists?.userId) throw new ConflictException('Celular já vinculado a outra conta');

    if (dto.profileType === ProfileType.individual) {
      const cpfExists = await this.prisma.individualProfile.findUnique({ where: { cpf: dto.cpf } });
      if (cpfExists) throw new ConflictException('CPF já cadastrado');
    } else {
      const cnpjExists = await this.prisma.businessProfile.findUnique({ where: { cnpj: dto.cnpj } });
      if (cnpjExists) throw new ConflictException('CNPJ já cadastrado');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user = await this.prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          name: dto.name,
          email: dto.email,
          phone: dto.phone,
          passwordHash,
          profileType: dto.profileType,
        },
      });

      if (dto.profileType === ProfileType.individual) {
        await tx.individualProfile.create({
          data: {
            userId: createdUser.id,
            cpf: dto.cpf!,
            birthDate: dto.birthDate ? new Date(dto.birthDate) : undefined,
          },
        });
      } else {
        await tx.businessProfile.create({
          data: {
            userId: createdUser.id,
            companyName: dto.companyName!,
            tradeName: dto.tradeName,
            cnpj: dto.cnpj!,
          },
        });
      }

      await tx.account.create({
        data: {
          userId: createdUser.id,
          name: 'Conta Principal',
          type: AccountType.checking,
          initialBalance: 0,
          currentBalance: 0,
          currency: 'BRL',
        },
      });

      await tx.whatsappContact.upsert({
        where: { phoneNumber },
        update: {
          userId: createdUser.id,
          provider: 'cloud-api',
          isVerified: true,
        },
        create: {
          userId: createdUser.id,
          phoneNumber,
          provider: 'cloud-api',
          isVerified: true,
        },
      });

      return createdUser;
    });

    const { passwordHash: _, ...result } = user;
    return result;
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) throw new UnauthorizedException('Credenciais inválidas');

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Credenciais inválidas');

    const tokens = await this.generateTokens(user.id, user.email);
    const { passwordHash: _, ...result } = user;
    return { user: result, ...tokens };
  }

  async refresh(userId: string, email: string) {
    return this.generateTokens(userId, email);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { individualProfile: true, businessProfile: true },
    });
    if (!user) throw new UnauthorizedException();

    const hasProfile =
      user.profileType === 'individual'
        ? !!user.individualProfile
        : !!user.businessProfile;

    const { passwordHash: _, individualProfile, businessProfile, ...rest } = user;
    return { ...rest, hasProfile };
  }

  private async generateTokens(userId: string, email: string) {
    const payload = { sub: userId, email };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.config.get('JWT_SECRET'),
        expiresIn: '15m',
      }),
      this.jwtService.signAsync(payload, {
        secret: this.config.get('JWT_REFRESH_SECRET'),
        expiresIn: '7d',
      }),
    ]);
    return { accessToken, refreshToken };
  }
}
