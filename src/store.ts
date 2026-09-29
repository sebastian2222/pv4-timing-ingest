import type { TimingUpdate } from './validate';

export type Outcome = 'ACCEPTED' | 'IGNORED' | 'REJECTED';

/** The fields the processor needs in order to choose a transaction and to log why. */
export interface StoredAthlete {
  revision: number;
  status: string;
  lane: number;
  timeMs: number;
}

export type TxResult =
  | { kind: 'COMMITTED' }
  | { kind: 'ALREADY_PROCESSED'; outcome: Outcome }
  | { kind: 'RETRY'; reason: 'CONDITION_FAILED' | 'CONFLICT' | 'TRANSIENT' };

/**
 * Thrown when a write may or may not have landed (network drop after commit,
 * throttle, 5xx). The processor retries the same requestId; the delivery
 * marker makes a second commit a no-op.
 */
export class RetryableStoreError extends Error {
  constructor(message = 'retryable store error') {
    super(message);
    this.name = 'RetryableStoreError';
  }
}

export interface Store {
  getAthlete(eventId: string, bib: string): Promise<StoredAthlete | undefined>;
  createAthlete(u: TimingUpdate, requestId: string): Promise<TxResult>;
  advanceAthlete(u: TimingUpdate, requestId: string): Promise<TxResult>;
  recordIgnored(u: TimingUpdate, requestId: string): Promise<TxResult>;
  recordRejected(requestId: string): Promise<TxResult>;
}
