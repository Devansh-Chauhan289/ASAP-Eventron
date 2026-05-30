import { Injectable, Logger } from '@nestjs/common';
import { ProviderUnavailableError } from '@shared/common/errors/domain-error';

type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface Breaker {
  state: State;
  failures: number;
  openedAt: number;
}

/**
 * Per-provider circuit breaker (Section 12). Phase-1 in-memory implementation; Phase 2
 * persists to provider.CircuitState for cross-instance coordination. Trips OPEN after N
 * consecutive failures, rejects fast while OPEN, probes once after a cooldown (HALF_OPEN).
 */
@Injectable()
export class CircuitBreaker {
  private readonly logger = new Logger(CircuitBreaker.name);
  private readonly breakers = new Map<string, Breaker>();
  private readonly threshold = 5;
  private readonly cooldownMs = 30_000;

  async run<T>(provider: string, fn: () => Promise<T>): Promise<T> {
    const b = this.get(provider);

    if (b.state === 'OPEN') {
      if (Date.now() - b.openedAt >= this.cooldownMs) {
        b.state = 'HALF_OPEN';
        this.logger.warn(`Circuit ${provider} HALF_OPEN (probing)`);
      } else {
        throw new ProviderUnavailableError(provider);
      }
    }

    try {
      const result = await fn();
      this.onSuccess(provider, b);
      return result;
    } catch (err) {
      this.onFailure(provider, b);
      throw err;
    }
  }

  state(provider: string): State {
    return this.get(provider).state;
  }

  private get(provider: string): Breaker {
    let b = this.breakers.get(provider);
    if (!b) {
      b = { state: 'CLOSED', failures: 0, openedAt: 0 };
      this.breakers.set(provider, b);
    }
    return b;
  }

  private onSuccess(provider: string, b: Breaker): void {
    if (b.state !== 'CLOSED') {
      this.logger.log(`Circuit ${provider} CLOSED (recovered)`);
    }
    b.state = 'CLOSED';
    b.failures = 0;
  }

  private onFailure(provider: string, b: Breaker): void {
    b.failures += 1;
    if (b.state === 'HALF_OPEN' || b.failures >= this.threshold) {
      b.state = 'OPEN';
      b.openedAt = Date.now();
      this.logger.error(`Circuit ${provider} OPEN after ${b.failures} failures`);
    }
  }
}
