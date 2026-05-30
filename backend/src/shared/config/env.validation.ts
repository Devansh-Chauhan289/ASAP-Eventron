import { z } from 'zod';

/**
 * Environment is validated at boot (Section 17.8). A misconfigured deploy fails
 * fast and loud instead of erroring at the first request under load.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  SWAGGER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  DATABASE_URL: z.string().url().or(z.string().startsWith('postgresql://')),

  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional().default(''),

  JWT_ACCESS_SECRET: z.string().min(8),
  JWT_REFRESH_SECRET: z.string().min(8),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(2592000),

  STRIPE_SECRET_KEY: z.string().default('sk_test_placeholder'),
  STRIPE_WEBHOOK_SECRET: z.string().default('whsec_placeholder'),

  TICKETMASTER_API_KEY: z.string().default('tm_sandbox_placeholder'),
  TICKETMASTER_BASE_URL: z
    .string()
    .default('https://app.ticketmaster.com/discovery/v2'),

  SENDGRID_API_KEY: z.string().default(''),
  SENDGRID_FROM_EMAIL: z.string().default('no-reply@asap.app'),

  OUTBOX_RELAY_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
});

export type AppEnv = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): AppEnv {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
