export const STATUSES = ['PROVISIONAL', 'CONFIRMED', 'OFFICIAL'] as const;
export type Status = (typeof STATUSES)[number];

/** GraphQL `Int` is a signed 32-bit integer. Anything larger can be stored but never served. */
export const GRAPHQL_INT_MAX = 2 ** 31 - 1;

export interface TimingUpdate {
  eventId: string;
  bib: string;
  lane: number;
  revision: number;
  status: Status;
  timeMs: number;
  recordedAt?: unknown;
}

export interface FieldError { field: string; reason: string }

export type Validation =
  | { ok: true; update: TimingUpdate }
  | { ok: false; errors: FieldError[] };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const nonEmptyString = (v: unknown) => typeof v === 'string' && v.trim().length > 0;

const int32 = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= GRAPHQL_INT_MAX;

export function validateUpdate(raw: unknown): Validation {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ field: '$', reason: 'body must be a JSON object' }] };
  }
  const errors: FieldError[] = [];
  const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);

  if (!has('eventId') || !nonEmptyString(raw.eventId)) errors.push({ field: 'eventId', reason: 'required non-empty string' });
  if (!has('bib') || !nonEmptyString(raw.bib)) errors.push({ field: 'bib', reason: 'required non-empty string' });
  if (!has('lane') || !int32(raw.lane)) errors.push({ field: 'lane', reason: 'required integer' });
  if (!has('revision') || !int32(raw.revision) || (raw.revision as number) < 1)
    errors.push({ field: 'revision', reason: 'required integer >= 1' });
  if (!has('status') || typeof raw.status !== 'string' || !(STATUSES as readonly string[]).includes(raw.status))
    errors.push({ field: 'status', reason: `must be one of ${STATUSES.join(', ')}` });
  if (!has('timeMs') || !int32(raw.timeMs) || (raw.timeMs as number) < 1)
    errors.push({ field: 'timeMs', reason: 'required integer > 0' });

  if (errors.length) return { ok: false, errors };

  // Copy only the known fields: nothing unexpected is ever persisted.
  return {
    ok: true,
    update: {
      eventId: raw.eventId as string,
      bib: raw.bib as string,
      lane: raw.lane as number,
      revision: raw.revision as number,
      status: raw.status as Status,
      timeMs: raw.timeMs as number,
      recordedAt: raw.recordedAt,
    },
  };
}
