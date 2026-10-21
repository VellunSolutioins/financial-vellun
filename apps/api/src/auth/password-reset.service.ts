import { createHash, randomBytes } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';

import { normalizeEmail } from '../common/email.util';
import { fieldInvalid } from '../common/field-errors';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext, SecurityEventsService } from '../security-events/security-events.service';
import { SessionService } from './session.service';

/** Validade do link de redefinição. */
export const RESET_TOKEN_TTL_MINUTES = 60;
/**
 * Intervalo mínimo entre dois e-mails para a mesma conta. O rate limit da rota
 * conta por IP; isto impede que alguém, trocando de IP, encha de e-mails a
 * caixa de outra pessoa.
 */
export const RESET_REQUEST_COOLDOWN_MS = 60_000;

/** Resposta do pedido, exista a conta ou não: não revela quem tem cadastro. */
export const FORGOT_PASSWORD_MESSAGE =
  'Se houver uma conta com esse e-mail, enviamos um link para você criar uma senha nova.';
export const INVALID_RESET_LINK_MESSAGE = 'Este link é inválido ou já expirou. Peça um novo.';

/** O banco guarda só o SHA-256 do token; o token em claro vai apenas no e-mail. */
export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * "Esqueci minha senha": emite o link de uso único e troca a senha por ele.
 *
 * Trocar a senha por aqui encerra **todas** as sessões da conta: quem pede a
 * recuperação pode estar justamente tirando um invasor de dentro.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly securityEvents: SecurityEventsService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Responde na hora, sempre com a mesma mensagem, e faz o trabalho depois: se
   * a resposta esperasse a consulta e o envio, o tempo dela denunciaria quais
   * e-mails têm conta.
   */
  requestReset(email: string, context: RequestContext = {}): { message: string } {
    void this.issueAndSend(email, context).catch((error: unknown) => {
      this.logger.error(
        'Falha ao processar pedido de redefinição de senha',
        error instanceof Error ? error.stack : undefined,
      );
    });
    return { message: FORGOT_PASSWORD_MESSAGE };
  }

  /** Emite o token e envia o e-mail. Separado de `requestReset` para os testes. */
  async issueAndSend(email: string, context: RequestContext = {}): Promise<void> {
    const user = await this.prisma.user.findFirst({
      // Sem diferenciar maiúsculas, como o login: contas antigas não têm e-mail normalizado.
      where: { email: { equals: normalizeEmail(email), mode: 'insensitive' } },
      select: { id: true, name: true, email: true },
    });
    if (!user) return;

    const now = new Date();
    const recent = await this.prisma.passwordResetToken.findFirst({
      where: {
        userId: user.id,
        usedAt: null,
        createdAt: { gt: new Date(now.getTime() - RESET_REQUEST_COOLDOWN_MS) },
      },
      select: { id: true },
    });
    if (recent) return;

    const token = randomBytes(32).toString('hex');
    await this.prisma.$transaction([
      // Um link por vez: pedir outro invalida os anteriores.
      this.prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
      this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashResetToken(token),
          expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MINUTES * 60_000),
        },
      }),
    ]);

    await this.securityEvents.record(user.id, 'password_reset_requested', context);
    await this.mail.sendPasswordReset({
      to: user.email,
      name: user.name,
      resetUrl: `${this.webUrl()}/redefinir-senha?token=${token}`,
      expiresInMinutes: RESET_TOKEN_TTL_MINUTES,
    });
  }

  async resetPassword(
    token: string,
    newPassword: string,
    context: RequestContext = {},
  ): Promise<{ message: string }> {
    const now = new Date();
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashResetToken(token) },
      select: { id: true, userId: true, usedAt: true, expiresAt: true },
    });
    if (!record || record.usedAt || record.expiresAt <= now) throw this.invalidLink();

    const passwordHash = await bcrypt.hash(newPassword, 12);
    const claimed = await this.prisma.$transaction(async (tx) => {
      // Consome o token de forma atômica: dois envios simultâneos do mesmo
      // link não trocam a senha duas vezes.
      const { count } = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (count === 0) return false;

      await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
      await tx.passwordResetToken.deleteMany({
        where: { userId: record.userId, id: { not: record.id } },
      });
      return true;
    });
    if (!claimed) throw this.invalidLink();

    const encerradas = await this.sessions.revokeAllForUser(record.userId);
    await this.securityEvents.record(record.userId, 'password_reset', {
      ...context,
      metadata: { sessoesEncerradas: encerradas },
    });

    return { message: 'Senha redefinida. Entre com a senha nova.' };
  }

  private invalidLink() {
    return fieldInvalid('token', INVALID_RESET_LINK_MESSAGE);
  }

  private webUrl(): string {
    return (this.config.get<string>('WEB_URL') ?? 'http://localhost:3000').replace(/\/+$/, '');
  }
}
