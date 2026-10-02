import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { JwtAuthGuard, RolesGuard } from './auth.guards';

/**
 * Module d'authentification.
 *
 * JwtAuthGuard est enregistre comme garde GLOBAL : la protection par
 * defaut s'applique donc a toute route declaree apres ce module, sans
 * oubl i possible.
 */
@Global()
@Module({
  imports: [
    JwtModule.register({
      // Le secret et la duree sont resolus au moment de l'usage (voir
      // TokenService) : aucune valeur n'est figee ici, ce qui permet
      // de les faire tourner sans redemarrer le module.
      global: true,
      verifyOptions: { ignoreExpiration: false },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    OtpService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService, TokenService, PasswordService, OtpService],
})
export class AuthModule {}