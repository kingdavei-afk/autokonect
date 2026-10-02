import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import {
  changePasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  verifyPhoneSchema,
  type ChangePasswordInput,
  type LoginInput,
  type RegisterInput,
  type RequestPasswordResetInput,
  type ResetPasswordInput,
  type VerifyPhoneInput,
} from './auth.schema';
import {
  CurrentUser,
  JwtAuthGuard,
  RolesGuard,
  type AuthenticatedUser,
} from './auth.guards';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';
import type { TokenPair } from './token.service';

/**
 * Surface d'authentification.
 *
 * Limitation de debit appliquee par endpoint : les codes OTP et les
 * mots de passe sont les seules ciblesarkovables en force brute (CDCS
 * 12.4). Les limites sont volontairement asymetriques — 5 tentatives
 * pour un code a 6 chiffres, 10 pour une connexion.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // ------------------------------------------------------------------
  // Inscription
  // ------------------------------------------------------------------

  @Public()
  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body(zodPipe(registerSchema)) input: RegisterInput,
    @Req() request: Request,
  ) {
    return this.auth.register(input, AuthController.contextOf(request));
  }

  // ------------------------------------------------------------------
  // Verification du numero
  // ------------------------------------------------------------------

  @Public()
  @Post('verify-phone')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async verifyPhone(
    @Body(zodPipe(verifyPhoneSchema)) input: VerifyPhoneInput,
    @Req() request: Request,
  ) {
    return this.auth.verifyPhone(input, AuthController.contextOf(request));
  }

  // ------------------------------------------------------------------
  // Connexion
  // ------------------------------------------------------------------

  @Public()
  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(zodPipe(loginSchema)) input: LoginInput,
    @Req() request: Request,
  ): Promise<TokenPair> {
    return this.auth.login(input, AuthController.contextOf(request));
  }

  // ------------------------------------------------------------------
  // Session
  // ------------------------------------------------------------------

  @Public()
  @Post('refresh')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body(zodPipe(refreshSchema)) body: { refreshToken: string },
    @Req() request: Request,
  ): Promise<TokenPair> {
    return this.auth.refresh(body.refreshToken, AuthController.contextOf(request));
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body(zodPipe(refreshSchema)) body: { refreshToken: string }): Promise<void> {
    await this.auth.logout(body.refreshToken);
  }

  @UseGuards(RolesGuard)
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.auth.logoutAll(user.id);
  }

  // ------------------------------------------------------------------
  // Mot de passe
  // ------------------------------------------------------------------

  /**
   * Demande de reinitialisation.
   *
   * Repond `accepted: true` que le compte existe ou non : c'est ce qui
   * empeche d' enumerer les comptes enregistres (CDCS 12.4).
   */
  @Public()
  @Post('password/forgot')
  @Throttle({ default: { limit: 3, ttl: 300_000 } })
  @HttpCode(HttpStatus.ACCEPTED)
  async requestPasswordReset(
    @Body(zodPipe(requestPasswordResetSchema)) input: RequestPasswordResetInput,
    @Req() request: Request,
  ) {
    return this.auth.requestPasswordReset(input, AuthController.contextOf(request));
  }

  @Public()
  @Post('password/reset')
  @Throttle({ default: { limit: 5, ttl: 300_000 } })
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Body(zodPipe(resetPasswordSchema)) input: ResetPasswordInput,
    @Req() request: Request,
  ) {
    return this.auth.resetPassword(input, AuthController.contextOf(request));
  }

  @UseGuards(RolesGuard)
  @Post('password/change')
  @Throttle({ default: { limit: 5, ttl: 300_000 } })
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodPipe(changePasswordSchema)) input: ChangePasswordInput,
    @Req() request: Request,
  ) {
    return this.auth.changePassword(user.id, input, AuthController.contextOf(request));
  }

  // ------------------------------------------------------------------
  // Profil
  // ------------------------------------------------------------------

  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.profile(user.id);
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  /**
   * Adresse IP du client.
   *
   * `trust proxy` est active dans main.ts, donc `req.ip` tient compte
   * de l'en-tete X-Forwarded-For pose par l'equilibrage de charge.
   */
  private static contextOf(request: Request): {
    ip: string | null;
    userAgent: string | null;
  } {
    return {
      ip: request.ip ?? null,
      userAgent: typeof request.headers['user-agent'] === 'string'
        ? request.headers['user-agent']
        : null,
    };
  }
}