import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { NotificationChannel, Prisma } from '@prisma/client';
import { DomainEventBus } from '@shared/outbox/domain-event-bus';
import { DomainEventEnvelope } from '@shared/events/domain-event.envelope';
import { EVENTS } from '@shared/events/event-names';
import { QUEUES } from '@shared/queue/queues';
import { UsersFacade } from '@modules/identity/users.facade';
import { NotificationRepository } from '../infrastructure/notification.repository';
import { SendgridAdapter } from '../infrastructure/sendgrid.adapter';

interface DispatchPayload {
  userId: string;
  channel: NotificationChannel;
  templateId: string;
  dedupeKey: string;
  data: Record<string, unknown>;
}

const TEMPLATES: Record<string, (d: Record<string, unknown>) => { subject: string; text: string }> = {
  trip_confirmed: () => ({
    subject: 'Your trip is confirmed 🎉',
    text: 'Great news — your trip is fully booked and confirmed. See you there!',
  }),
  trip_cancelled: () => ({
    subject: 'Your trip was cancelled',
    text: 'We were unable to complete your booking, so it has been cancelled. You were not charged.',
  }),
};

/**
 * Notifications (supporting). Subscribes to notification.dispatch.requested (choreography,
 * Section 5.4), creates a de-duplicated notification, and enqueues delivery. Never inline in a
 * booking transaction — always triggered by a domain event.
 */
@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly bus: DomainEventBus,
    private readonly repo: NotificationRepository,
    private readonly sendgrid: SendgridAdapter,
    private readonly users: UsersFacade,
    @InjectQueue(QUEUES.NOTIFICATIONS) private readonly queue: Queue,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe(
      EVENTS.NOTIFICATION_DISPATCH_REQUESTED,
      (e) => this.onDispatchRequested(e),
    );
  }

  private async onDispatchRequested(event: DomainEventEnvelope): Promise<void> {
    const p = event.payload as unknown as DispatchPayload;
    const created = await this.repo.createIfNew({
      userId: p.userId,
      channel: p.channel ?? 'EMAIL',
      templateId: p.templateId,
      dedupeKey: p.dedupeKey,
      payload: p.data as Prisma.InputJsonValue,
      correlationId: event.correlationId,
    });
    if (!created) {
      this.logger.debug(`Notification ${p.templateId}/${p.dedupeKey} deduped`);
      return; // already created by a prior delivery of this event
    }
    await this.queue.add(
      'deliver',
      { notificationId: created.id },
      { jobId: `notif:${created.id}`, attempts: 5, backoff: { type: 'exponential', delay: 3000 } },
    );
  }

  /** Called by the BullMQ processor. Idempotent: re-delivery of a SENT notification is skipped. */
  async deliver(notificationId: string): Promise<void> {
    const n = await this.repo.findById(notificationId);
    if (!n || n.status === 'SENT' || n.status === 'DELIVERED') return;

    await this.repo.setStatus(n.id, 'SENDING');
    const contact = await this.users.getContact(n.userId);
    if (!contact) {
      await this.repo.setStatus(n.id, 'FAILED');
      return;
    }

    const render = TEMPLATES[n.templateId] ?? (() => ({
      subject: 'ASAP update',
      text: 'You have an update on your trip.',
    }));
    const { subject, text } = render(n.payload as Record<string, unknown>);

    const result = await this.sendgrid.send({ to: contact.email, subject, text });
    await this.repo.recordAttempt(
      n.id,
      'EMAIL',
      result.ok,
      result.response as Prisma.InputJsonValue,
    );
    if (result.ok) {
      await this.repo.setStatus(n.id, 'SENT');
    } else {
      await this.repo.setStatus(n.id, 'RETRYING');
      throw new Error('Notification delivery failed; will retry');
    }
  }

  listForUser(userId: string, limit: number) {
    return this.repo.listForUser(userId, limit);
  }

  markRead(id: string) {
    return this.repo.markRead(id);
  }
}
