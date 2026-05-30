import 'reflect-metadata';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfig } from './shared/config/config.module';
import { AllExceptionsFilter } from './shared/common/filters/all-exceptions.filter';

async function bootstrap(): Promise<void> {
  // rawBody:true preserves the raw payload needed for Stripe webhook signature verification.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  const config = app.get(AppConfig);

  app.use(helmet());
  app.enableCors({ origin: config.allowedOrigins, credentials: true });

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' }); // -> /api/v1

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  app.enableShutdownHooks(); // OnModuleDestroy -> Prisma $disconnect, BullMQ drain
  app.set('trust proxy', 1); // behind API Gateway / ALB

  if (config.swaggerEnabled && !config.isProd) {
    const doc = new DocumentBuilder()
      .setTitle('ASAP API')
      .setDescription('All-in-One Smart Attendance Platform — see backend/API.md')
      .setVersion('1')
      .addBearerAuth()
      .build();
    SwaggerModule.setup(
      'api/v1/docs',
      app,
      SwaggerModule.createDocument(app, doc),
    );
  }

  const server = await app.listen(config.port);
  // Keep-alive must exceed the ALB idle timeout to avoid spurious 502s.
  (server as { keepAliveTimeout?: number }).keepAliveTimeout = 65_000;

  // Graceful shutdown for ECS/Fargate SIGTERM (RTO<=30min, zero-drop deploys).
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      void app.close().then(() => process.exit(0));
    });
  }

  console.log(`ASAP API listening on :${config.port} (env=${config.env})`);
}

void bootstrap();
