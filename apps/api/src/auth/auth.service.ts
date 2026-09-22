import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { AccountType, ProfileType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeEmail } from '../common/email.util';
import { WhatsappLinkService } from '../whatsapp-link/whatsapp-link.service';
import { SessionMeta, SessionService } from './session.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private sessions: SessionService,
    private whatsappLink: WhatsappLinkService,
  ) {}

  /**
   * Cria a conta. O telefone fica só como dado de cadastro: o vínculo com o
   * WhatsApp exige o desafio de posse (`/users/me/phone/verification`), e a
   * boas-vindas passou a ser a resposta do bot a esse desafio — enviá-la aqui
   * mandava mensagem, com o nome do cadastrante, a um número não comprovado.
   *
   * Também não se consulta mais se o telefone já pertence a outra conta: isso
   * revelava quais números têm cadastro, e quem provar a posse leva o vínculo.
   */
  async register(dto: RegisterDto) {
    const email = normalizeEmail(dto.email);
    const exists = await this.findUserByEmail(email);
    if (exists) throw new ConflictException('Email já cadastrado');

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
          email,
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

      return createdUser;
    });

    const { passwordHash: _, ...result } = user;
    return result;
  }

  async login(dto: LoginDto, meta: SessionMeta = {}) {
    const user = await this.findUserByEmail(normalizeEmail(dto.email));
    if (!user) throw new UnauthorizedException('Credenciais inválidas');

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Credenciais inválidas');

    const [tokens, whatsappVerified] = await Promise.all([
      this.sessions.createSession(user.id, meta),
      this.whatsappLink.hasLinkedPhone(user.id),
    ]);
    const { passwordHash: _, ...result } = user;
    return { user: { ...result, whatsappVerified }, tokens };
  }

  async me(userId: string) {
    const [user, whatsappVerified] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        include: { individualProfile: true, businessProfile: true },
      }),
      this.whatsappLink.hasLinkedPhone(userId),
    ]);
    if (!user) throw new UnauthorizedException();

    const hasProfile =
      user.profileType === 'individual' ? !!user.individualProfile : !!user.businessProfile;

    const { passwordHash: _, individualProfile, businessProfile, ...rest } = user;
    return { ...rest, hasProfile, whatsappVerified };
  }

  /**
   * Busca por e-mail sem diferenciar maiúsculas: contas antigas foram gravadas
   * como digitadas, antes de o e-mail passar a ser normalizado.
   */
  private findUserByEmail(email: string) {
    return this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });
  }
}
