import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule, ConfigService } from '@nestjs/config';
import { validateEnv, AppEnv } from './env.validation';

/**
 * Typed configuration accessor so the rest of the app never touches raw process.env.
 */
export class AppConfig {
  constructor(private readonly cfg: ConfigService) {}

  private req<K extends keyof AppEnv>(key: K): AppEnv[K] {
    const v = this.cfg.get(key as string);
    if (v === undefined || v === null) {
      throw new Error(`Missing config key: ${String(key)}`);
    }
    return v as AppEnv[K];
  }

  get env() {
    return this.req('NODE_ENV');
  }
  get isProd() {
    return this.env === 'production';
  }
  get port() {
    return this.req('PORT');
  }
  get allowedOrigins(): string[] {
    return this.req('ALLOWED_ORIGINS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  get swaggerEnabled() {
    return this.req('SWAGGER_ENABLED');
  }
  get databaseUrl() {
    return this.req('DATABASE_URL');
  }
  get redis() {
    return {
      host: this.req('REDIS_HOST'),
      port: this.req('REDIS_PORT'),
      password: this.req('REDIS_PASSWORD') || undefined,
    };
  }
  get jwt() {
    return {
      accessSecret: this.req('JWT_ACCESS_SECRET'),
      refreshSecret: this.req('JWT_REFRESH_SECRET'),
      accessTtl: this.req('JWT_ACCESS_TTL'),
      refreshTtl: this.req('JWT_REFRESH_TTL'),
    };
  }
  get stripe() {
    return {
      secretKey: this.req('STRIPE_SECRET_KEY'),
      webhookSecret: this.req('STRIPE_WEBHOOK_SECRET'),
    };
  }
  get ticketmaster() {
    return {
      apiKey: this.req('TICKETMASTER_API_KEY'),
      baseUrl: this.req('TICKETMASTER_BASE_URL'),
    };
  }
  get sendgrid() {
    return {
      apiKey: this.req('SENDGRID_API_KEY'),
      fromEmail: this.req('SENDGRID_FROM_EMAIL'),
    };
  }
  get outboxRelayIntervalMs() {
    return this.req('OUTBOX_RELAY_INTERVAL_MS');
  }
  get logLevel() {
    return this.req('LOG_LEVEL');
  }
}

/**
 * @Global config module. In production the env is hydrated from AWS Secrets Manager
 * before the process starts (see docs/architecture/15-aws-infrastructure.md); here we
 * validate whatever is present with zod.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
  ],
  providers: [
    {
      provide: AppConfig,
      useFactory: (cfg: ConfigService) => new AppConfig(cfg),
      inject: [ConfigService],
    },
  ],
  exports: [AppConfig],
})
export class AppConfigModule {}
