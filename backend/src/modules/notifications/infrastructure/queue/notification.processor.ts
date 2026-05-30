import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUES } from '@shared/queue/queues';
import { NotificationService } from '../../application/notification.service';

/** Delivers queued notifications via the configured channel (Section 11). */
@Processor(QUEUES.NOTIFICATIONS, { concurrency: 10 })
export class NotificationProcessor extends WorkerHost {
  constructor(private readonly service: NotificationService) {
    super();
  }

  async process(job: Job<{ notificationId: string }>): Promise<void> {
    await this.service.deliver(job.data.notificationId);
  }
}
