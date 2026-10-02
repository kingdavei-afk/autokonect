import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { IS_PUBLIC_KEY } from '../../common/tokens';
import { TokenService, type UserRole } from './token.service';

/** Utilisateur authentifie, tel qu'expose aux controleurs. */
export interface AuthenticatedUser {
  id: string;
  roles: UserRole[];
  /** Identifiant de correlation de la requete courante. */
  requestId: string;
}

/** Metadata portant les roles autorises. */
export const ROLES_KEY = 'roles';

/**
 * Restreint une route a certains roles.
 *
 * A utiliser avec JwtAuthGuard : ce decorateur n'ouvre rien par
 * lui-meme, il exige simplement des roles supplementaires.
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** Injecte l'utilisateur authentifie dans la methode du controleur. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<
      Request & { user: AuthenticatedUser }
    >();
    return request.user;
  },
);

/**
 * Garde globale d'authentification.
 *
 * Regle par defaut : toute route est PROTEGEE ; le decorateur `@Public`
 * ouvre explicitement une route. L'erreur la plus grave et la plus
 * frequente en API etant d'oublier de proteger une route, elle est
 * rendue impossible par construction (CDCS 12.3).
 *
 * Le jeton est verifie par signature, sans requete en base. Le controle
 * d'etat du compte est fait a l'emission ; la revocation immediate est
 * assuree par la duree courte du jeton d'acces (15 minutes).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<
      Request & { user?: AuthenticatedUser }
    >();

    const header = request.headers['authorization'];

    if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) {
      throw new UnauthorizedException({
        code: 'MISSING_TOKEN',
        message: 'En-tete "Authorization: Bearer <jeton>" attendu.',
      });
    }

    const token = header.slice(7).trim();

    try {
      const payload = await this.tokens.verifyAccessToken(token);

      request.user = {
        id: payload.sub,
        roles: (payload.roles ?? []) as UserRole[],
        requestId: request.requestId,
      };
      return true;
    } catch (error) {
      const code =
        (error as Error).message === 'type_de_jeton_inattendu'
          ? 'WRONG_TOKEN_TYPE'
          : 'INVALID_TOKEN';

      throw new UnauthorizedException({
        code,
        message: 'Jeton invalide ou expire.',
      });
    }
  }
}

/**
 * Filtre les roles : exige au moins un des roles autorises.
 *
 * L'absence de role sur une route signifie « accessible a tout
 * utilisateur authentifie » ; l'absence d'utilisateur ne passe pas.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    const { user } = context.switchToHttp().getRequest<{
      user?: AuthenticatedUser;
    }>();

    if (!user) {
      throw new UnauthorizedException({
        code: 'MISSING_TOKEN',
        message: 'Authentification requise.',
      });
    }

    if (!required.some((role) => user.roles.includes(role))) {
      throw new ForbiddenException({
        code: 'FORBIDDEN_ROLE',
        message: "Vous n'avez pas les droits necessaires pour cette operation.",
      });
    }

    return true;
  }
}