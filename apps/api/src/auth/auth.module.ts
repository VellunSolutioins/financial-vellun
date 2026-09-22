import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { WhatsappLinkModule } from '../whatsapp-link/whatsapp-link.module';

@Module({
  imports: [PassportModule, JwtModule.register({}), WhatsappLinkModule],
  controllers: [AuthController],
  providers: [AuthService, SessionService, JwtStrategy],
  exports: [AuthService, SessionService],
})
export class AuthModule {}
