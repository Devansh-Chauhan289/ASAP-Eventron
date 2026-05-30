import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { SharedModule } from './shared/shared.module';
import { IdentityModule } from './modules/identity/identity.module';
import { ProviderIntegrationModule } from './modules/provider-integration/provider-integration.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { EventBookingModule } from './modules/event-booking/event-booking.module';
import { TripModule } from './modules/trip/trip.module';
import { DiscoveryModule } from './modules/discovery/discovery.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { JwtAuthGuard } from './shared/common/guards/jwt-auth.guard';
import { RolesGuard } from './shared/common/guards/roles.guard';
import { IdempotencyInterceptor } from './shared/idempotency/idempotency.interceptor';
import { CorrelationMiddleware } from './shared/common/middleware/correlation.middleware';

/**
 * ASAP modular monolith composition root (Section 17.2). Order: shared kernel first, then the
 * generic ACL, then contexts. Global guards (JWT -> RBAC) and the idempotency interceptor are
 * registered here so every route is protected and every @Idempotent() POST is replay-safe.
 */
@Module({
  imports: [
    SharedModule,
    IdentityModule,
    ProviderIntegrationModule,
    PaymentsModule,
    EventBookingModule,
    TripModule,
    DiscoveryModule,
    NotificationsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
