import type { TimingUpdate } from './validate';
import {
  RetryableStoreError,
  type Outcome,
  type Store,
  type StoredAthlete,
  type TxResult,
} from './store';

export type Fault = 'CONFLICT' | 'LOST_RESPONSE' | 'TRANSIENT';

export interface SnapshotResult {
  bib: string;
  lane: number;
  revision: number;
  status: string;
  timeMs: number;
}

export interface SnapshotStats {
  eventId: string;
  athletesTracked: number;
  updatesAccepted: number;
  updatesIgnored: number;
}

interface AthleteRow extends SnapshotResult {
  eventId: string;
}

interface StatsRow {
  athletesTracked: number;
  updatesAccepted: number;
  updatesIgnored: number;
}

type Work =
  | { kind: 'ALREADY'; outcome: Outcome }
  | { kind: 'FAIL' }
  | { kind: 'OK'; apply: () => void };

/**
 * In-memory Store with the same all-or-nothing rules as the DynamoDB
 * transactions. Fault injection covers the cases that are awkward to
 * reproduce against a real table.
 */
export class FakeStore implements Store {
  private athletes = new Map<string, AthleteRow>();
  private stats = new Map<string, StatsRow>();
  private eventOrder: string[] = [];
  private deliveries = new Map<string, Outcome>();
  private rejected = 0;
  private faults: Fault[] = [];
  private hooks: Array<(store: FakeStore) => void | Promise<void>> = [];

  /** The next transaction hits this fault. CONFLICT writes nothing and returns RETRY. */
  injectNext(fault: Fault): void {
    this.faults.push(fault);
  }

  /**
   * Runs at the start of the next transaction, before its conditions are
   * checked. Used to simulate another request winning the race after our read.
   */
  interceptNext(fn: (store: FakeStore) => void | Promise<void>): void {
    this.hooks.push(fn);
  }

  async getAthlete(eventId: string, bib: string): Promise<StoredAthlete | undefined> {
    const row = this.athletes.get(keyOf(eventId, bib));
    if (!row) return undefined;
    return { revision: row.revision, status: row.status, lane: row.lane, timeMs: row.timeMs };
  }

  createAthlete(u: TimingUpdate, requestId: string): Promise<TxResult> {
    return this.transact(() => {
      const seen = this.deliveries.get(requestId);
      if (seen) return { kind: 'ALREADY', outcome: seen };
      if (this.athletes.has(keyOf(u.eventId, u.bib))) return { kind: 'FAIL' };
      return {
        kind: 'OK',
        apply: () => {
          this.athletes.set(keyOf(u.eventId, u.bib), {
            eventId: u.eventId, bib: u.bib, lane: u.lane, revision: u.revision, status: u.status, timeMs: u.timeMs,
          });
          const st = this.statsFor(u.eventId);
          st.updatesAccepted += 1;
          st.athletesTracked += 1;
          if (!this.eventOrder.includes(u.eventId)) this.eventOrder.push(u.eventId);
          this.deliveries.set(requestId, 'ACCEPTED');
        },
      };
    });
  }

  advanceAthlete(u: TimingUpdate, requestId: string): Promise<TxResult> {
    return this.transact(() => {
      const seen = this.deliveries.get(requestId);
      if (seen) return { kind: 'ALREADY', outcome: seen };
      const row = this.athletes.get(keyOf(u.eventId, u.bib));
      // Same predicate as ConditionExpression `#revision < :rev`.
      if (!row || !(row.revision < u.revision)) return { kind: 'FAIL' };
      return {
        kind: 'OK',
        apply: () => {
          row.lane = u.lane;
          row.revision = u.revision;
          row.status = u.status;
          row.timeMs = u.timeMs;
          this.statsFor(u.eventId).updatesAccepted += 1;
          this.deliveries.set(requestId, 'ACCEPTED');
        },
      };
    });
  }

  recordIgnored(u: TimingUpdate, requestId: string): Promise<TxResult> {
    return this.transact(() => {
      const seen = this.deliveries.get(requestId);
      if (seen) return { kind: 'ALREADY', outcome: seen };
      const row = this.athletes.get(keyOf(u.eventId, u.bib));
      // ConditionCheck: the revision we decided to ignore is still not newer.
      if (!row || row.revision < u.revision) return { kind: 'FAIL' };
      return {
        kind: 'OK',
        apply: () => {
          this.statsFor(u.eventId).updatesIgnored += 1;
          this.deliveries.set(requestId, 'IGNORED');
        },
      };
    });
  }

  recordRejected(requestId: string): Promise<TxResult> {
    return this.transact(() => {
      const seen = this.deliveries.get(requestId);
      if (seen) return { kind: 'ALREADY', outcome: seen };
      return {
        kind: 'OK',
        apply: () => {
          this.rejected += 1;
          this.deliveries.set(requestId, 'REJECTED');
        },
      };
    });
  }

  snapshot() {
    return {
      events: [...this.eventOrder],
      results: (eventId: string): SnapshotResult[] =>
        [...this.athletes.values()]
          .filter((a) => a.eventId === eventId)
          .map(({ bib, lane, revision, status, timeMs }) => ({ bib, lane, revision, status, timeMs })),
      eventStats: (eventId: string): SnapshotStats => {
        const st = this.stats.get(eventId);
        return {
          eventId,
          athletesTracked: st?.athletesTracked ?? 0,
          updatesAccepted: st?.updatesAccepted ?? 0,
          updatesIgnored: st?.updatesIgnored ?? 0,
        };
      },
      updatesRejected: this.rejected,
    };
  }

  private statsFor(eventId: string): StatsRow {
    let st = this.stats.get(eventId);
    if (!st) {
      st = { athletesTracked: 0, updatesAccepted: 0, updatesIgnored: 0 };
      this.stats.set(eventId, st);
    }
    return st;
  }

  private async transact(work: () => Work): Promise<TxResult> {
    // Reserve this call's fault before the hook, so a nested write inside the
    // hook does not consume it.
    const fault = this.faults.shift();
    const hook = this.hooks.shift();
    if (hook) await hook(this);

    if (fault === 'CONFLICT') return { kind: 'RETRY', reason: 'CONFLICT' };
    if (fault === 'TRANSIENT') throw new RetryableStoreError('transient');

    const result = work();
    if (result.kind === 'ALREADY') return { kind: 'ALREADY_PROCESSED', outcome: result.outcome };
    if (result.kind === 'FAIL') return { kind: 'RETRY', reason: 'CONDITION_FAILED' };

    result.apply();
    if (fault === 'LOST_RESPONSE') throw new RetryableStoreError('lost response');
    return { kind: 'COMMITTED' };
  }
}

function keyOf(eventId: string, bib: string): string {
  return `${eventId}\0${bib}`;
}
