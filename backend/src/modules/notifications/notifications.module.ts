import { Module } from '@nestjs/common';
import { NotificationService } from './application/notification.service';
import { NotificationRepository } from './infrastructure/notification.repository';
import { SendgridAdapter } from './infrastructure/sendgrid.adapter';
import { NotificationProcessor } from './infrastructure/queue/notification.processor';
import { NotificationsController } from './interface/notifications.controller';
import { IdentityModule } from '@modules/identity/identity.module';

/**
 * Notifications (supporting). Subscribes to notification.dispatch.requested via the DomainEventBus
 * and delivers asynchronously through BullMQ — never inside a booking transaction (Section 4.4).
 */
@Module({
  imports: [IdentityModule],
  controllers: [NotificationsController],
  providers: [
    NotificationService,
    NotificationRepository,
    SendgridAdapter,
    NotificationProcessor,
  ],
})
export class NotificationsModule {}
