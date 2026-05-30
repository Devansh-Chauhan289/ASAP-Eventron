import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AppConfig } from '../../config/config.module';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { UnauthenticatedError } from '../errors/domain-error';
import { AuthUser } from '../decorators/current-user.decorator';
import { CorrelationContext } from '../context/correlation.context';

interface AccessTokenClaims {
  sub: string;
  email: string;
  role: AuthUser['role'];
}

/**
 * Validates the Bearer access token (Section 13). Routes marked @Public() bypass it.
 * On success attaches req.user and stamps the correlation context with userId.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const token = this.extract(req);
    if (!token) throw new UnauthenticatedError();

    try {
      const claims = await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        secret: this.config.jwt.accessSecret,
      });
      const user: AuthUser = {
        userId: claims.sub,
        email: claims.email,
        role: claims.role,
      };
      req.user = user;
      CorrelationContext.set({ userId: user.userId });
      return true;
    } catch {
      throw new UnauthenticatedError('Invalid or expired token');
    }
  }

  private extract(req: Request): string | null {
    const header = req.header('authorization');
    if (!header) return null;
    const [type, token] = header.split(' ');
    return type === 'Bearer' && token ? token : null;
  }
}
