import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomUUID } from 'crypto';
import { UserRepository } from '../infrastructure/user.repository';
import { AppConfig } from '@shared/config/config.module';
import {
  ConflictError,
  UnauthenticatedError,
  NotFoundError,
} from '@shared/common/errors/domain-error';
import { AuthUser } from '@shared/common/decorators/current-user.decorator';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface RefreshClaims {
  sub: string;
  sid: string; // session id
}

/**
 * Authentication use-cases (Section 13). Argon2id password hashing, JWT access tokens,
 * and rotating refresh tokens persisted as a hash in identity.Session (never plaintext).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly users: UserRepository,
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
  ) {}

  async register(input: {
    email: string;
    password: string;
    displayName: string;
  }): Promise<{ user: PublicUser; tokens: TokenPair }> {
    const existing = await this.users.findByEmail(input.email);
    if (existing) throw new ConflictError('Email already registered');

    const passwordHash = await argon2.hash(input.password, {
      type: argon2.argon2id,
    });
    const user = await this.users.createWithCredential({
      email: input.email,
      displayName: input.displayName,
      passwordHash,
    });
    const tokens = await this.issueTokens(this.toAuthUser(user));
    return { user: this.toPublic(user), tokens };
  }

  async login(input: {
    email: string;
    password: string;
    userAgent?: string;
    ip?: string;
  }): Promise<{ user: PublicUser; tokens: TokenPair }> {
    const user = await this.users.findByEmail(input.email);
    if (!user || !user.credential) throw new UnauthenticatedError('Invalid credentials');

    const ok = await argon2.verify(user.credential.passwordHash, input.password);
    if (!ok) throw new UnauthenticatedError('Invalid credentials');

    const tokens = await this.issueTokens(this.toAuthUser(user), {
      userAgent: input.userAgent,
      ip: input.ip,
    });
    return { user: this.toPublic(user), tokens };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    let claims: RefreshClaims;
    try {
      claims = await this.jwt.verifyAsync<RefreshClaims>(refreshToken, {
        secret: this.config.jwt.refreshSecret,
      });
    } catch {
      throw new UnauthenticatedError('Invalid refresh token');
    }

    const session = await this.users.findSession(claims.sid);
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw new UnauthenticatedError('Session expired');
    }
    // Rotation: the presented token must match the stored hash, else treat as reuse/theft.
    if (session.refreshHash !== this.hashToken(refreshToken)) {
      await this.users.revokeSession(session.id);
      throw new UnauthenticatedError('Refresh token reuse detected');
    }

    const user = await this.users.findById(claims.sub);
    if (!user) throw new UnauthenticatedError();

    return this.rotate(session.id, this.toAuthUser(user));
  }

  async logout(refreshToken: string): Promise<void> {
    try {
      const claims = await this.jwt.verifyAsync<RefreshClaims>(refreshToken, {
        secret: this.config.jwt.refreshSecret,
      });
      await this.users.revokeSession(claims.sid);
    } catch {
      // logout is best-effort; an invalid token is already "logged out"
    }
  }

  async getProfile(userId: string): Promise<PublicUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError('User', userId);
    return this.toPublic(user);
  }

  async updateProfile(
    userId: string,
    data: { displayName?: string; phone?: string },
  ): Promise<PublicUser> {
    const user = await this.users.updateProfile(userId, data);
    return this.toPublic(user);
  }

  async registerDevice(
    userId: string,
    token: string,
    platform: string,
  ): Promise<void> {
    await this.users.upsertDeviceToken(userId, token, platform);
  }

  // ── token helpers ──────────────────────────────────────────────
  private async issueTokens(
    user: AuthUser,
    meta?: { userAgent?: string; ip?: string },
  ): Promise<TokenPair> {
    const sessionId = randomUUID();
    const refreshToken = await this.signRefresh(user.userId, sessionId);
    const expiresAt = new Date(Date.now() + this.config.jwt.refreshTtl * 1000);
    await this.users.createSession({
      id: sessionId, // persist with the SAME id encoded in the refresh JWT
      userId: user.userId,
      refreshHash: this.hashToken(refreshToken),
      expiresAt,
      userAgent: meta?.userAgent,
      ip: meta?.ip,
    });
    const accessToken = await this.signAccess(user);
    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.jwt.accessTtl,
    };
  }

  private async rotate(sessionId: string, user: AuthUser): Promise<TokenPair> {
    const refreshToken = await this.signRefresh(user.userId, sessionId);
    const expiresAt = new Date(Date.now() + this.config.jwt.refreshTtl * 1000);
    await this.users.rotateSession(
      sessionId,
      this.hashToken(refreshToken),
      expiresAt,
    );
    const accessToken = await this.signAccess(user);
    return { accessToken, refreshToken, expiresIn: this.config.jwt.accessTtl };
  }

  private signAccess(user: AuthUser): Promise<string> {
    return this.jwt.signAsync(
      { sub: user.userId, email: user.email, role: user.role },
      {
        secret: this.config.jwt.accessSecret,
        expiresIn: this.config.jwt.accessTtl,
      },
    );
  }

  private signRefresh(userId: string, sessionId: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: userId, sid: sessionId },
      {
        secret: this.config.jwt.refreshSecret,
        expiresIn: this.config.jwt.refreshTtl,
      },
    );
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private toAuthUser(user: {
    id: string;
    email: string;
    role: string;
  }): AuthUser {
    return {
      userId: user.id,
      email: user.email,
      role: user.role as AuthUser['role'],
    };
  }

  private toPublic(user: {
    id: string;
    email: string;
    displayName: string;
    phone: string | null;
    createdAt: Date;
  }): PublicUser {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      phone: user.phone,
      createdAt: user.createdAt.toISOString(),
    };
  }
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  phone: string | null;
  createdAt: string;
}
