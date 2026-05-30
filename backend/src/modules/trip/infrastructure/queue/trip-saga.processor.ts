import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUES } from '@shared/queue/queues';
import { CorrelationContext } from '@shared/common/context/correlation.context';
import { TripSagaProcessManager } from '../../application/saga/trip-saga.process-manager';

/**
 * BullMQ worker that drives the Trip saga (Section 17.5). Concurrency=1-per-trip is guaranteed
 * by the jobId (`trip-saga:{tripId}`). On throw, BullMQ retries and the saga resumes from the
 * persisted SagaState.step — durable across worker/task restarts (Phase-1 exit criterion 5).
 */
@Processor(QUEUES.SAGA, { concurrency: 8 })
export class TripSagaProcessor extends WorkerHost {
  private readonly logger = new Logger(TripSagaProcessor.name);

  constructor(private readonly saga: TripSagaProcessManager) {
    super();
  }

  async process(job: Job<{ tripId: string }>): Promise<void> {
    const { tripId } = job.data;
    await CorrelationContext.run({ tripId }, async () => {
      this.logger.debug(`Driving saga for trip ${tripId} (attempt ${job.attemptsMade + 1})`);
      await this.saga.drive(tripId);
    });
  }
}
