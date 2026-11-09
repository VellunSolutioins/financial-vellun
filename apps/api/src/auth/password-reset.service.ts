import { createHash, randomBytes } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';

import { normalizeEmail } from '../common/email.util';
import { fieldInvalid } from '../common/field-errors';
import { webUrl } from '../common/web-url.util';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext, SecurityEventsService } from '../security-events/security-events.service';
import { PasswordChangeNotifier } from './password-change-notifier.service';
import { SessionService } from './session.service';

/** Validade do link de redefinição. */
export const RESET_TOKEN_TTL_MINUTES = 30;
/**
 * Intervalo mínimo entre dois e-mails para a mesma conta. O rate limit da rota
 * conta por IP; isto impede que alguém, trocando de IP, encha de e-mails a
 * caixa de outra pessoa.
 */
export const RESET_REQUEST_COOLDOWN_SECONDS = 60;
/**
 * Teto de e-mails por hora para a mesma conta. Só o intervalo ainda deixaria
 * mandar 60 por hora, o bastante para incomodar a pessoa e queimar a
 * reputação do domínio de envio.
 */
export const RESET_REQUESTS_PER_HOUR = 3;

/** Resposta do pedido, exista a conta ou não: não revela quem tem cadastro. */
export const FORGOT_PASSWORD_MESSAGE =
  'Se houver uma conta com esse e-mail, enviamos um link para você criar uma senha nova.';
export const INVALID_RESET_LINK_MESSAGE = 'Este link é inválido ou já expirou. Peça um novo.';

/**
 * Corpo da resposta de `POST /auth/forgot-password`. Os prazos são os mesmos
 * para qualquer e-mail; vão na resposta para o web não manter uma cópia deles.
 */
export interface ForgotPasswordResponse {
  message: string;
  /** Validade do link enviado. */
  expiresInMinutes: number;
  /** Espera antes de pedir outro link para o mesmo e-mail. */
  retryAfterSeconds: number;
}

/** O banco guarda só o SHA-256 do token; o token em claro vai apenas no e-mail. */
export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Chave do advisory lock que serializa os pedidos de uma mesma conta. */
function requestLockKey(userId: string): string {
  return `password-reset:${userId}`;
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
    private readonly notifier: PasswordChangeNotifier,
  ) {}

  /**
   * Responde na hora, sempre com o mesmo corpo, e faz o trabalho depois: se a
   * resposta esperasse a consulta e o envio, o tempo dela denunciaria quais
   * e-mails têm conta.
   */
  requestReset(email: string, context: RequestContext = {}): ForgotPasswordResponse {
    void this.issueAndSend(email, context).catch((error: unknown) => {
      this.logger.error(
        'Falha ao processar pedido de redefinição de senha',
        error instanceof Error ? error.stack : undefined,
      );
    });
    return {
      message: FORGOT_PASSWORD_MESSAGE,
      expiresInMinutes: RESET_TOKEN_TTL_MINUTES,
      retryAfterSeconds: RESET_REQUEST_COOLDOWN_SECONDS,
    };
  }

  /**
   * Emite o token e envia o e-mail. Separado de `requestReset` para os testes.
   * Retorna se um e-mail foi enviado.
   */
  async issueAndSend(email: string, context: RequestContext = {}): Promise<boolean> {
    const user = await this.prisma.user.findFirst({
      // Sem diferenciar maiúsculas, como o login: contas antigas não têm e-mail normalizado.
      where: { email: { equals: normalizeEmail(email), mode: 'insensitive' } },
      select: { id: true, name: true, email: true },
    });
    if (!user) return false;

    const token = randomBytes(32).toString('hex');
    const issued = await this.prisma.$transaction(async (tx) => {
      // Serializa os pedidos desta conta até o fim da transação. Sem a trava,
      // pedidos simultâneos (de IPs diferentes, que o rate limit não segura)
      // passavam todos pela checagem do intervalo antes de algum gravar o token,
      // e cada um mandava um e-mail.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${requestLockKey(user.id)}))`;

      const now = new Date();
      const recent = await tx.passwordResetToken.findFirst({
        where: {
          userId: user.id,
          createdAt: { gt: new Date(now.getTime() - RESET_REQUEST_COOLDOWN_SECONDS * 1000) },
        },
        select: { id: true },
      });
      if (recent) return false;

      // O teto por hora conta os eventos da trilha, não os tokens: pedir um
      // link novo apaga os anteriores.
      const lastHour = await tx.userSecurityEvent.count({
        where: {
          userId: user.id,
          type: 'password_reset_requested',
          createdAt: { gt: new Date(now.getTime() - 60 * 60_000) },
        },
      });
      if (lastHour >= RESET_REQUESTS_PER_HOUR) return false;

      // Um link por vez: pedir outro invalida (e apaga) os anteriores.
      await tx.passwordResetToken.deleteMany({ where: { userId: user.id } });
      await tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashResetToken(token),
          expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MINUTES * 60_000),
        },
      });
      // Dentro da transação, sob a trava: é o que o teto acima conta.
      await this.securityEvents.record(user.id, 'password_reset_requested', context, tx);
      return true;
    });
    if (!issued) return false;

    await this.mail.sendPasswordReset({
      to: user.email,
      name: user.name,
      // No fragmento, o token não chega a servidor nenhum: nem ao log HTTP de
      // quem serve o web, nem a um `Referer`. A tela o lê e limpa da barra.
      resetUrl: `${webUrl(this.config)}/redefinir-senha#token=${token}`,
      expiresInMinutes: RESET_TOKEN_TTL_MINUTES,
    });
    return true;
  }

  async resetPassword(
    token: string,
    newPassword: string,
    context: RequestContext = {},
  ): Promise<{ message: string }> {
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashResetToken(token) },
      select: { id: true, userId: true, expiresAt: true },
    });
    if (!record || record.expiresAt <= new Date()) throw this.invalidLink();

    const passwordHash = await bcrypt.hash(newPassword, 12);
    // Tudo numa transação: senha nova, links consumidos e sessões encerradas
    // acontecem juntos. Se algo falhar, nada muda e o mesmo link continua
    // servindo para tentar de novo.
    const done = await this.prisma.$transaction(async (tx) => {
      // Consome o token de forma atômica: dois envios simultâneos do mesmo
      // link não trocam a senha duas vezes (o segundo espera a trava da linha e
      // já não a encontra).
      const { count } = await tx.passwordResetToken.deleteMany({
        where: { id: record.id, expiresAt: { gt: new Date() } },
      });
      if (count === 0) return null;

      const user = await tx.user.update({
        where: { id: record.userId },
        data: { passwordHash },
        select: { id: true, email: true, name: true },
      });
      // Os demais links da conta, se houver, também deixam de valer.
      await tx.passwordResetToken.deleteMany({ where: { userId: record.userId } });
      const encerradas = await this.sessions.revokeAllForUser(record.userId, undefined, tx);
      return { user, encerradas };
    });
    if (done === null) throw this.invalidLink();

    await this.securityEvents.record(record.userId, 'password_reset', {
      ...context,
      metadata: { sessoesEncerradas: done.encerradas },
    });
    this.notifier.notify(done.user, 'reset');

    return { message: 'Senha redefinida. Entre com a senha nova.' };
  }

  /**
   * Apaga os links vencidos. Os usados já saem na própria redefinição; estes
   * são os que expiraram sem uso. Retorna quantos foram removidos.
   */
  async purgeExpired(now = new Date()): Promise<number> {
    const { count } = await this.prisma.passwordResetToken.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return count;
  }

  private invalidLink() {
    return fieldInvalid('token', INVALID_RESET_LINK_MESSAGE);
  }
}
