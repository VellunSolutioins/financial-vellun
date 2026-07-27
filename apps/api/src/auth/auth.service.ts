import { createHash, randomBytes } from 'node:crypto';

import {
  BadRequestException,
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
import { MailService } from '../mail/mail.service';
import { WelcomeNotificationService } from '../notifications/welcome-notification.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

/** Validade do link de redefinição de senha. */
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Resposta de `forgot-password`: sempre a mesma, exista ou não o e-mail — não
 * podemos revelar quais endereços têm conta.
 */
const FORGOT_PASSWORD_MESSAGE =
  'Se o e-mail estiver cadastrado, enviamos um link para redefinir a senha.';

/** Só o hash do token é persistido; o valor em claro vive apenas no link. */
function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private config: ConfigService,
    private welcomeNotification: WelcomeNotificationService,
    private mail: MailService,
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
      const cnpjExists = await this.prisma.businessProfile.findUnique({
        where: { cnpj: dto.cnpj },
      });
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
          postalCode: dto.postalCode,
          street: dto.street,
          addressNumber: dto.addressNumber,
          complement: dto.complement,
          neighborhood: dto.neighborhood,
          city: dto.city,
          state: dto.state,
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

    // Após o commit do cadastro: dispara (best-effort, sem bloquear a resposta)
    // a mensagem de boas-vindas no WhatsApp com instruções de uso. O novo
    // cliente não conhece o número do app — esta é a primeira mensagem dele.
    void this.welcomeNotification.sendWelcome({
      phone: phoneNumber,
      name: dto.name,
      profileType: dto.profileType,
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

  /**
   * Inicia a recuperação de senha. Invalida pedidos anteriores, gera um token
   * de uso único (1h) e dispara o e-mail. A resposta é sempre genérica.
   */
  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });

    if (user) {
      // Um pedido novo invalida os anteriores ainda não usados.
      await this.prisma.passwordResetToken.deleteMany({
        where: { userId: user.id, usedAt: null },
      });

      const token = randomBytes(32).toString('hex');
      await this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashResetToken(token),
          expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
        },
      });

      const webUrl = (this.config.get<string>('WEB_URL') ?? 'http://localhost:3000').replace(
        /\/+$/,
        '',
      );
      await this.mail.sendPasswordReset(
        user.email,
        user.name,
        `${webUrl}/redefinir-senha?token=${token}`,
      );
    }

    return { message: FORGOT_PASSWORD_MESSAGE };
  }

  /** Conclui a recuperação: valida o token, troca a senha e marca o uso. */
  async resetPassword(dto: ResetPasswordDto) {
    const resetToken = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashResetToken(dto.token) },
    });

    if (!resetToken || resetToken.usedAt || resetToken.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Link inválido ou expirado');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: resetToken.userId }, data: { passwordHash } }),
      this.prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { usedAt: new Date() },
      }),
    ]);

    return { message: 'Senha redefinida com sucesso' };
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
      user.profileType === 'individual' ? !!user.individualProfile : !!user.businessProfile;

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
