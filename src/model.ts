/**
 * In-memory reference implementation of the pipeline's semantics.
 *
 * Two jobs:
 *  1. Unit-test oracle: the rules are proven here without AWS in the way.
 *  2. E2E oracle: feed the same sequence to this and to the deployed stack,
 *     then assert the GraphQL answers match what this computes.
 *
 * The DynamoDB implementation should be a line-for-line mapping of ingest():
 *  - deliveryId check  → a dedupe item written inside the same TransactWriteItems
 *  - decide()          → ConditionExpression on the athlete item
 *  - counter bumps     → ADD on the event-stats item, in the same transaction
 */
import { decide } from './decide';
import { validateUpdate, type FieldError, type Status } from './validate';

export interface Result { bib: string; lane: number; revision: number; status: Status; timeMs: number }
export interface EventStats { eventId: string; athletesTracked: number; updatesAccepted: number; updatesIgnored: number }
export type Outcome = 'ACCEPTED' | 'IGNORED' | 'REJECTED' | 'ALREADY_PROCESSED';

export class ReferenceStore {
  private athletes = new Map<string, Map<string, Result>>(); // eventId -> bib -> result
  private stats = new Map<string, { accepted: number; ignored: number }>();
  private rejected: { raw: unknown; errors: FieldError[] }[] = [];
  private seenDeliveries = new Map<string, Outcome>();

  ingest(raw: unknown, deliveryId?: string): Outcome {
    if (deliveryId !== undefined && this.seenDeliveries.has(deliveryId)) return 'ALREADY_PROCESSED';
    const outcome = this.apply(raw);
    if (deliveryId !== undefined) this.seenDeliveries.set(deliveryId, outcome);
    return outcome;
  }

  /** Body that never made it to JSON — rejected at the edge. Must hit the same counter. */
  rejectUnparseable(rawText: string): Outcome {
    this.rejected.push({ raw: rawText, errors: [{ field: '$', reason: 'invalid JSON' }] });
    return 'REJECTED';
  }

  private apply(raw: unknown): Outcome {
    const v = validateUpdate(raw);
    if (!v.ok) {
      this.rejected.push({ raw, errors: v.errors });
      return 'REJECTED';
    }
    const { eventId, bib, lane, revision, status, timeMs } = v.update;
    const bibs = this.athletes.get(eventId) ?? new Map<string, Result>();
    const st = this.stats.get(eventId) ?? { accepted: 0, ignored: 0 };

    if (decide(bibs.get(bib)?.revision, revision) === 'APPLY') {
      bibs.set(bib, { bib, lane, revision, status, timeMs });
      st.accepted++;
      this.athletes.set(eventId, bibs);
      this.stats.set(eventId, st);
      return 'ACCEPTED';
    }
    st.ignored++;
    this.stats.set(eventId, st);
    return 'IGNORED';
  }

  events(): string[] {
    return [...this.athletes.keys()];
  }

  results(eventId: string): Result[] {
    return [...(this.athletes.get(eventId)?.values() ?? [])].map((r) => ({ ...r }));
  }

  eventStats(eventId: string): EventStats {
    const st = this.stats.get(eventId);
    return {
      eventId,
      athletesTracked: this.athletes.get(eventId)?.size ?? 0,
      updatesAccepted: st?.accepted ?? 0,
      updatesIgnored: st?.ignored ?? 0,
    };
  }

  updatesRejected(): number {
    return this.rejected.length;
  }

  rejectedPayloads() {
    return this.rejected;
  }
}
