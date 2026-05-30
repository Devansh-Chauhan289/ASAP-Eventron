import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfig } from '../config/config.module';
import { Public } from '../common/decorators/public.decorator';

/**
 * Liveness vs readiness (Section 17.8). /health/live = process up. /health/ready checks Prisma
 * + Redis so the ALB only routes to healthy tasks (drives the rolling-deploy / 99.9% story).
 */
@ApiTags('health')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async ready() {
    const checks: Record<string, 'ok' | 'fail'> = {};
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch {
      checks.database = 'fail';
    }
    checks.redis = await this.pingRedis();
    const ok = Object.values(checks).every((v) => v === 'ok');
    return { status: ok ? 'ok' : 'degraded', checks };
  }

  private async pingRedis(): Promise<'ok' | 'fail'> {
    const client = new Redis({
      host: this.config.redis.host,
      port: this.config.redis.port,
      password: this.config.redis.password,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    try {
      await client.connect();
      await client.ping();
      return 'ok';
    } catch {
      return 'fail';
    } finally {
      client.disconnect();
    }
  }
}
