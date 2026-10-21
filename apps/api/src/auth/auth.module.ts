import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { WhatsappLinkModule } from '../whatsapp-link/whatsapp-link.module';
import { MailModule } from '../mail/mail.module';
import { PasswordResetService } from './password-reset.service';

@Module({
  imports: [PassportModule, JwtModule.register({}), WhatsappLinkModule, MailModule],
  controllers: [AuthController],
  providers: [AuthService, SessionService, PasswordResetService, JwtStrategy],
  exports: [AuthService, SessionService],
})
export class AuthModule {}
