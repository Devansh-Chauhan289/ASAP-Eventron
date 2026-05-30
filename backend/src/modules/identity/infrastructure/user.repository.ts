import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';

/**
 * Wraps Prisma for the Identity context (Rule 5/7). Other contexts reference users by
 * `userId` only (logical ref) — they never query these tables (Rule 8).
 */
@Injectable()
export class UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      include: { credential: true },
    });
  }

  findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async createWithCredential(input: {
    email: string;
    displayName: string;
    passwordHash: string;
  }) {
    return this.prisma.user.create({
      data: {
        email: input.email,
        displayName: input.displayName,
        credential: { create: { passwordHash: input.passwordHash } },
      },
    });
  }

  updateProfile(id: string, data: { displayName?: string; phone?: string }) {
    return this.prisma.user.update({ where: { id }, data });
  }

  createSession(input: {
    userId: string;
    refreshHash: string;
    expiresAt: Date;
    userAgent?: string;
    ip?: string;
  }) {
    return this.prisma.session.create({ data: input });
  }

  findSession(id: string) {
    return this.prisma.session.findUnique({ where: { id } });
  }

  rotateSession(id: string, refreshHash: string, expiresAt: Date) {
    return this.prisma.session.update({
      where: { id },
      data: { refreshHash, expiresAt },
    });
  }

  revokeSession(id: string) {
    return this.prisma.session.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  upsertDeviceToken(userId: string, token: string, platform: string) {
    return this.prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, lastSeenAt: new Date() },
    });
  }
}
