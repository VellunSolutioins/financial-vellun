import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PhoneVerification, Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

import { randomNumericCode, safeEqual, sha256Hex } from '../common/crypto.util';
import { normalizePhone, phoneVariants } from '../common/phone.util';
import { PrismaService } from '../prisma/prisma.service';
import { SecurityEventsService } from '../security-events/security-events.service';

/** Validade do código exibido na tela. */
export const VERIFICATION_TTL_MS = 10 * 60 * 1000;
/** Códigos errados enviados do número antes de o desafio ser invalidado. */
export const MAX_VERIFICATION_ATTEMPTS = 5;
const PHONE_MASK = /^\(\d{2}\) \d{4,5}-\d{4}$/;

export type VerificationStatus = 'none' | 'pending' | 'verified' | 'expired';

export interface VerificationChallenge {
  status: 'pending';
  code: string;
  phone: string;
  expiresAt: Date;
  botNumber: string | null;
  waLink: string | null;
  message: string;
}

export interface VerificationState {
  status: VerificationStatus;
  phone: string | null;
  expiresAt: Date | null;
  /** Número hoje vinculado e verificado, se houver. */
  linkedPhone: string | null;
  botNumber: string | null;
}

export type ConfirmResult =
  | { status: 'verified'; userId: string; name: string; profileType: string }
  | { status: 'not_found' | 'invalid_code' | 'expired' };

type Tx = Prisma.TransactionClient;

/**
 * Vínculo entre usuário e número de WhatsApp (plano de segurança, S1.1/S1.2).
 *
 * O número informado no cadastro ou em "Minha Conta" não vincula nada. O
 * usuário recebe um código na tela e o envia ao bot **a partir do próprio
 * número**; o webhook assinado da Meta é o que prova a posse. Só então o
 * contato passa a identificar o usuário, e os números anteriores dele são
 * revogados na mesma transação.
 */
@Injectable()
export class WhatsappLinkService {
  private readonly logger = new Logger(WhatsappLinkService.name);
  private readonly botNumber: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly securityEvents: SecurityEventsService,
    config: ConfigService,
  ) {
    const digits = (config.get<string>('WHATSAPP_BOT_NUMBER') ?? '').replace(/\D/g, '');
    this.botNumber = digits || null;

    // Em produção, configuração faltando **derruba o boot**. Sem o número, a
    // tela de verificação perde o botão e o QR code e sobra o texto "envie esta
    // mensagem para o nosso WhatsApp" — o usuário precisa achar o contato
    // sozinho, no meio do cadastro. Ninguém abre um chamado por isso: desiste.
    // Um `warn` na subida não segura essa regressão, porque some no log.
    //
    // Fora de produção o aviso basta: rodar a stack local sem número de bot é
    // legítimo, e não há cadastro real em jogo.
    if (!this.botNumber) {
      const mensagem =
        'WHATSAPP_BOT_NUMBER não configurado: a tela de verificação fica sem link ' +
        'wa.me e sem QR code';
      if (process.env.NODE_ENV === 'production') {
        throw new Error(`${mensagem}. Defina o número do bot (só dígitos, com DDI).`);
      }
      this.logger.warn(mensagem);
    }
  }

  // ── Lado do usuário (web) ────────────────────────────────────────────────

  /**
   * Gera um novo desafio. Invalida os anteriores do usuário.
   *
   * Trocar um número já verificado exige a senha atual: sem isso, uma sessão
   * roubada bastaria para desviar o WhatsApp da conta para outro aparelho.
   */
  async startVerification(
    userId: string,
    input: { phone?: string; currentPassword?: string },
  ): Promise<VerificationChallenge> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const displayPhone = input.phone ?? user.phone;
    if (!displayPhone || !PHONE_MASK.test(displayPhone)) {
      throw new BadRequestException('Informe um celular válido ((00) 00000-0000)');
    }
    const phoneNumber = normalizePhone(displayPhone);

    const linked = await this.findLinkedContact(userId);
    const changingNumber =
      linked !== null && !phoneVariants(phoneNumber).includes(linked.phoneNumber);
    if (changingNumber) {
      const valid =
        !!input.currentPassword && (await bcrypt.compare(input.currentPassword, user.passwordHash));
      if (!valid) throw new UnauthorizedException('Senha atual incorreta');
    }

    const code = randomNumericCode();
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);

    await this.prisma.$transaction([
      this.prisma.phoneVerification.deleteMany({ where: { userId, consumedAt: null } }),
      this.prisma.phoneVerification.create({
        data: {
          id,
          userId,
          phoneNumber,
          displayPhone,
          codeHash: this.hashCode(id, code),
          expiresAt,
        },
      }),
    ]);

    const message = `Olá! Quero ativar meu WhatsApp no Financial Vellun. Código: ${code}`;
    return {
      status: 'pending',
      code,
      phone: displayPhone,
      expiresAt,
      botNumber: this.botNumber,
      waLink: this.botNumber
        ? `https://wa.me/${this.botNumber}?text=${encodeURIComponent(message)}`
        : null,
      message,
    };
  }

  /** Estado do último desafio, consultado pela tela a cada poucos segundos. */
  async getState(userId: string): Promise<VerificationState> {
    const [latest, linked, user] = await Promise.all([
      this.prisma.phoneVerification.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      }),
      this.findLinkedContact(userId),
      this.prisma.user.findUnique({ where: { id: userId }, select: { phone: true } }),
    ]);

    return {
      status: latest ? this.statusOf(latest, new Date()) : 'none',
      phone: latest?.displayPhone ?? null,
      expiresAt: latest?.expiresAt ?? null,
      linkedPhone: linked ? (user?.phone ?? linked.phoneNumber) : null,
      botNumber: this.botNumber,
    };
  }

  /** `true` quando o usuário tem um número verificado e ativo. */
  async hasLinkedPhone(userId: string): Promise<boolean> {
    return (await this.findLinkedContact(userId)) !== null;
  }

  // ── Lado do bot (API interna) ────────────────────────────────────────────

  /**
   * Confere o código enviado ao bot. `senderPhone` é o número de origem que a
   * Meta informou no webhook assinado — é ele que fica vinculado.
   *
   * O código só vale para o número que o usuário informou (com tolerância ao
   * nono dígito). Um código chutado de outro aparelho não encontra desafio.
   */
  async confirmFromWhatsapp(senderPhone: string, code: string): Promise<ConfirmResult> {
    const sender = normalizePhone(senderPhone);
    const now = new Date();

    const candidates = await this.prisma.phoneVerification.findMany({
      where: { phoneNumber: { in: phoneVariants(sender) }, consumedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    if (candidates.length === 0) return { status: 'not_found' };

    const live = candidates.filter((v) => this.statusOf(v, now) === 'pending');
    if (live.length === 0) return { status: 'expired' };

    const match = live.find((v) => safeEqual(v.codeHash, this.hashCode(v.id, code)));
    if (!match) {
      await this.prisma.phoneVerification.updateMany({
        where: { id: { in: live.map((v) => v.id) } },
        data: { attempts: { increment: 1 } },
      });
      return { status: 'invalid_code' };
    }

    const user = await this.prisma.$transaction((tx) => this.claim(tx, match, sender, now));
    if (!user) return { status: 'expired' };

    this.logger.log(`WhatsApp verificado para o usuário ${user.id}`);
    // A origem é o próprio WhatsApp: o ip aqui seria o do agente, não o do usuário.
    await this.securityEvents.record(user.id, 'phone_verified', {
      metadata: { origem: 'whatsapp', telefone: match.displayPhone },
    });
    return { status: 'verified', userId: user.id, name: user.name, profileType: user.profileType };
  }

  // ── Internos ─────────────────────────────────────────────────────────────

  /**
   * Consome o desafio e move o vínculo, tudo ou nada.
   *
   * O contato é travado com `SELECT ... FOR UPDATE` depois de garantido com
   * `INSERT ... ON CONFLICT DO NOTHING`: duas confirmações simultâneas para o
   * mesmo número se serializam, e só uma encontra o desafio ainda aberto.
   */
  private async claim(tx: Tx, verification: PhoneVerification, sender: string, now: Date) {
    const consumed = await tx.phoneVerification.updateMany({
      where: { id: verification.id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (consumed.count === 0) return null;

    await tx.phoneVerification.deleteMany({
      where: { userId: verification.userId, consumedAt: null },
    });

    await tx.$executeRaw`
      INSERT INTO whatsapp_contacts (id, phone_number, is_verified, link_version, created_at, updated_at)
      VALUES (${randomUUID()}, ${sender}, false, 0, ${now}, ${now})
      ON CONFLICT (phone_number) DO NOTHING`;
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM whatsapp_contacts WHERE phone_number = ${sender} FOR UPDATE`;
    const contact = await tx.whatsappContact.findUniqueOrThrow({ where: { id: locked.id } });

    const sameOwner =
      contact.userId === verification.userId && contact.isVerified && contact.revokedAt === null;
    if (sameOwner) {
      await tx.whatsappContact.update({
        where: { id: contact.id },
        data: { verifiedAt: now, provider: 'cloud-api' },
      });
    } else {
      // Novo dono (ou primeiro vínculo): quem provou a posse leva o número.
      // Conversas do dono anterior não podem continuar valendo para o novo.
      await tx.whatsappContact.update({
        where: { id: contact.id },
        data: {
          userId: verification.userId,
          isVerified: true,
          verifiedAt: now,
          revokedAt: null,
          provider: 'cloud-api',
          linkVersion: { increment: 1 },
        },
      });
      await this.closeActiveConversations(tx, [contact.id]);
    }

    await this.revokeOtherContacts(tx, verification.userId, contact.id, now);

    return tx.user.update({
      where: { id: verification.userId },
      data: { phone: verification.displayPhone },
    });
  }

  /** Revoga os demais números do usuário: só um número identifica a conta. */
  private async revokeOtherContacts(tx: Tx, userId: string, keepId: string, now: Date) {
    const others = await tx.whatsappContact.findMany({
      where: { userId, id: { not: keepId }, revokedAt: null },
      select: { id: true },
    });
    if (others.length === 0) return;

    const ids = others.map((c) => c.id);
    await tx.whatsappContact.updateMany({
      where: { id: { in: ids } },
      data: { isVerified: false, revokedAt: now, linkVersion: { increment: 1 } },
    });
    await this.closeActiveConversations(tx, ids);
  }

  private async closeActiveConversations(tx: Tx, contactIds: string[]) {
    await tx.aiConversation.updateMany({
      where: { whatsappContactId: { in: contactIds }, status: 'active' },
      data: { status: 'abandoned' },
    });
  }

  private findLinkedContact(userId: string) {
    return this.prisma.whatsappContact.findFirst({
      where: { userId, isVerified: true, revokedAt: null },
      orderBy: { updatedAt: 'desc' },
    });
  }

  private statusOf(v: PhoneVerification, now: Date): VerificationStatus {
    if (v.consumedAt) return 'verified';
    if (v.expiresAt.getTime() <= now.getTime() || v.attempts >= MAX_VERIFICATION_ATTEMPTS) {
      return 'expired';
    }
    return 'pending';
  }

  /** O id entra no hash: o mesmo código em dois desafios gera hashes diferentes. */
  private hashCode(verificationId: string, code: string): string {
    return sha256Hex(`${verificationId}:${code}`);
  }
}
