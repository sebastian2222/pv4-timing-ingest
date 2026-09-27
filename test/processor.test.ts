import { describe, expect, it } from 'vitest';
import { InMemoryDeadLetter } from '../src/deadLetter';
import { FakeStore } from '../src/fakeStore';
import { createLogger } from '../src/obs';
import { processUpdate, type ProcessDeps } from '../src/processor';
import { CORRUPTIONS } from '../src/scenario';
import type { Store } from '../src/store';

function harness(store: Store = new FakeStore()) {
  const deadLetter = new InMemoryDeadLetter();
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({ service: 'pv4-ingest' }, { sink: (line) => lines.push(JSON.parse(line)) });
  const deps: ProcessDeps = {
    store,
    deadLetter,
    log,
    sleep: async () => {},
    now: () => new Date('2026-08-25T00:00:00.000Z'),
  };
  return { store: store as FakeStore, deadLetter, lines, deps };
}

function body(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    eventId: 'UNIT-M100',
    bib: 'AUS-1147',
    lane: 3,
    revision: 1,
    status: 'PROVISIONAL',
    timeMs: 10105,
    recordedAt: '2026-08-25T19:42:07.000Z',
    ...over,
  });
}

async function post(deps: ProcessDeps, raw: string | null, requestId: string, isBase64Encoded = false) {
  const res = await processUpdate({ body: raw, isBase64Encoded, requestId }, deps);
  return { ...res, json: JSON.parse(res.body) as Record<string, unknown> };
}

describe('processor — worked example', () => {
  it('matches the brief: three accepted, three ignored, provisional revision 4', async () => {
    const { store, deps } = harness();
    const seq: [number, string][] = [
      [1, 'PROVISIONAL'],
      [3, 'OFFICIAL'],
      [2, 'CONFIRMED'],
      [3, 'OFFICIAL'],
      [3, 'CONFIRMED'],
      [4, 'PROVISIONAL'],
    ];
    const outcomes = [];
    for (let i = 0; i < seq.length; i++) {
      const [revision, status] = seq[i];
      const res = await post(deps, body({ revision, status }), `w${i}`);
      outcomes.push(res.json.outcome);
    }
    expect(outcomes).toEqual(['ACCEPTED', 'ACCEPTED', 'IGNORED', 'IGNORED', 'IGNORED', 'ACCEPTED']);
    expect(store.snapshot().results('UNIT-M100')).toEqual([
      { bib: 'AUS-1147', lane: 3, revision: 4, status: 'PROVISIONAL', timeMs: 10105 },
    ]);
    expect(store.snapshot().eventStats('UNIT-M100')).toEqual({
      eventId: 'UNIT-M100', athletesTracked: 1, updatesAccepted: 3, updatesIgnored: 3,
    });
    expect(store.snapshot().updatesRejected).toBe(0);
  });
});

describe('processor — HTTP contract', () => {
  it('returns 200 JSON for accepted and ignored updates', async () => {
    const { deps } = harness();
    const accepted = await post(deps, body(), 'a');
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers['content-type']).toBe('application/json');
    expect(accepted.json).toEqual({ outcome: 'ACCEPTED', requestId: 'a' });

    const ignored = await post(deps, body(), 'b');
    expect(ignored.statusCode).toBe(200);
    expect(ignored.headers['content-type']).toBe('application/json');
    expect(ignored.json).toEqual({ outcome: 'IGNORED', requestId: 'b' });
  });

  it('returns 400 listing every bad field', async () => {
    const { deps } = harness();
    const res = await post(deps, JSON.stringify({ eventId: '', bib: '', lane: 'x', revision: 0, status: 'nope', timeMs: -1 }), 'bad');
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.json.outcome).toBe('REJECTED');
    const fields = (res.json.errors as { field: string }[]).map((e) => e.field).sort();
    expect(fields).toEqual(['bib', 'eventId', 'lane', 'revision', 'status', 'timeMs']);
  });

  it.each([
    ['unparseable', '{"eventId":'],
    ['empty', ''],
    ['null body', null],
  ])('rejects %s and counts it', async (_name, raw) => {
    const { store, deps } = harness();
    const res = await post(deps, raw, 'bad');
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toBe('application/json');
    expect(store.snapshot().updatesRejected).toBe(1);
    expect(store.snapshot().events).toEqual([]);
  });

  it('rejects base64 that does not decode to JSON', async () => {
    const { store, deps } = harness();
    const res = await post(deps, '!!!not-base64!!!', 'bad', true);
    expect(res.statusCode).toBe(400);
    expect(store.snapshot().updatesRejected).toBe(1);
  });
});

describe('processor — validation', () => {
  it('rejects every corruption without a phantom athlete, and the next valid update still applies', async () => {
    const base = { eventId: 'UNIT-M100', bib: 'B1', lane: 1, revision: 1, status: 'PROVISIONAL', timeMs: 1000, recordedAt: 'x' };
    const { store, deps } = harness();
    await post(deps, body({ eventId: 'OTHER', bib: 'Z', revision: 1 }), 'seed');
    const before = store.snapshot().eventStats('OTHER');

    for (let i = 0; i < CORRUPTIONS.length; i++) {
      const res = await post(deps, JSON.stringify(CORRUPTIONS[i](base)), `c${i}`);
      expect(res.statusCode, `corruption ${i}`).toBe(400);
    }
    expect(store.snapshot().updatesRejected).toBe(CORRUPTIONS.length);
    expect(store.snapshot().events).toEqual(['OTHER']);
    expect(store.snapshot().eventStats('OTHER')).toEqual(before);
    expect(store.snapshot().results('UNIT-M100')).toEqual([]);

    const next = await post(deps, body(), 'after');
    expect(next.json.outcome).toBe('ACCEPTED');
    expect(store.snapshot().results('UNIT-M100')).toHaveLength(1);
  });

  it('dead-letters the raw payload and logs the key', async () => {
    const { deadLetter, lines, deps } = harness();
    const raw = JSON.stringify({ eventId: '', bib: 'B', lane: 1, revision: 1, status: 'PROVISIONAL', timeMs: 1 });
    await post(deps, raw, 'rej-1');
    expect(deadLetter.records).toHaveLength(1);
    expect(deadLetter.records[0]).toMatchObject({
      requestId: 'rej-1',
      receivedAt: '2026-08-25T00:00:00.000Z',
      errors: [{ field: 'eventId', reason: 'required non-empty string' }],
    });
    expect(deadLetter.records[0].raw).toEqual({ eventId: '', bib: 'B', lane: 1, revision: 1, status: 'PROVISIONAL', timeMs: 1 });
    const outcome = lines.find((l) => l.outcome === 'REJECTED');
    expect(outcome?.deadLetterKey).toBe('rejected/2026-08-25/rej-1.json');
  });

  it('retries a conflict on the reject path, and gives up after 8 without counting', async () => {
    const once = harness();
    once.store.injectNext('CONFLICT');
    const retried = await post(once.deps, '{', 'rej-retry');
    expect(retried.statusCode).toBe(400);
    expect(once.store.snapshot().updatesRejected).toBe(1);
    expect(once.lines.some((l) => l.TransactionConflictRetries === 1)).toBe(true);

    const exhausted = harness();
    for (let i = 0; i < 8; i++) exhausted.store.injectNext('CONFLICT');
    const failed = await post(exhausted.deps, '{', 'rej-fail');
    expect(failed.statusCode).toBe(503);
    expect(exhausted.store.snapshot().updatesRejected).toBe(0);
    expect(exhausted.lines.some((l) => l.ProcessingFailures === 1)).toBe(true);
  });

  it('still returns 400 and counts the rejection when the dead-letter write throws', async () => {
    const h = harness();
    h.deps.deadLetter = { put: async () => { throw new Error('s3 down'); } };
    const res = await post(h.deps, '{', 'rej-2');
    expect(res.statusCode).toBe(400);
    expect(h.store.snapshot().updatesRejected).toBe(1);
    expect(h.lines.some((l) => l.level === 'ERROR')).toBe(true);
  });
});

describe('processor — ordering', () => {
  it('ignores a lower revision and records the reason STALE', async () => {
    const { store, lines, deps } = harness();
    await post(deps, body({ revision: 3, status: 'OFFICIAL' }), 'a');
    const res = await post(deps, body({ revision: 2, status: 'CONFIRMED' }), 'b');
    expect(res.json.outcome).toBe('IGNORED');
    expect(store.snapshot().results('UNIT-M100')[0]).toMatchObject({ revision: 3, status: 'OFFICIAL' });
    expect(lines.find((l) => l.outcome === 'IGNORED')).toMatchObject({ reason: 'STALE', storedRevision: 3 });
  });

  it('ignores an equal revision with a different status', async () => {
    const { store, lines, deps } = harness();
    await post(deps, body({ revision: 3, status: 'OFFICIAL', timeMs: 10105, lane: 3 }), 'a');
    const res = await post(deps, body({ revision: 3, status: 'CONFIRMED', timeMs: 9999, lane: 4 }), 'b');
    expect(res.json.outcome).toBe('IGNORED');
    expect(store.snapshot().results('UNIT-M100')[0].status).toBe('OFFICIAL');
    const line = lines.find((l) => l.requestId === 'b' && l.outcome === 'IGNORED');
    expect(line).toMatchObject({ reason: 'DUPLICATE_OR_SAME_REVISION' });
    expect(lines.some((l) => l.msg === 'conflicting revision' && l.level === 'WARN')).toBe(true);
    expect(lines.some((l) => l.ConflictingRevision === 1)).toBe(true);
  });

  it('applies a jury reopen: OFFICIAL then a higher revision that is PROVISIONAL', async () => {
    const { store, lines, deps } = harness();
    await post(deps, body({ revision: 2, status: 'OFFICIAL' }), 'a');
    const res = await post(deps, body({ revision: 3, status: 'PROVISIONAL' }), 'b');
    expect(res.json.outcome).toBe('ACCEPTED');
    expect(store.snapshot().results('UNIT-M100')[0]).toMatchObject({ revision: 3, status: 'PROVISIONAL' });
    expect(lines.some((l) => l.ResultsReopened === 1)).toBe(true);
  });

  it('keeps the same bib in two events independent, and accepts a first revision other than 1', async () => {
    const { store, deps } = harness();
    expect((await post(deps, body({ eventId: 'E1', revision: 7, status: 'CONFIRMED' }), 'a')).json.outcome).toBe('ACCEPTED');
    expect((await post(deps, body({ eventId: 'E2', revision: 1, status: 'PROVISIONAL' }), 'b')).json.outcome).toBe('ACCEPTED');
    expect(store.snapshot().results('E1')[0].revision).toBe(7);
    expect(store.snapshot().results('E2')[0].revision).toBe(1);
    expect((await post(deps, body({ eventId: 'E1', revision: 6 }), 'c')).json.outcome).toBe('IGNORED');
    expect(store.snapshot().eventStats('E2').updatesIgnored).toBe(0);
  });
});

describe('processor — retries and idempotency', () => {
  it('retries one conflict and counts the update once', async () => {
    const { store, lines, deps } = harness();
    store.injectNext('CONFLICT');
    const res = await post(deps, body(), 'a');
    expect(res.json.outcome).toBe('ACCEPTED');
    expect(store.snapshot().eventStats('UNIT-M100').updatesAccepted).toBe(1);
    expect(lines.some((l) => l.TransactionConflictRetries === 1)).toBe(true);
  });

  it('does not double-count when the accept response is lost', async () => {
    const { store, deps } = harness();
    store.injectNext('LOST_RESPONSE');
    const res = await post(deps, body(), 'a');
    expect(res.statusCode).toBe(200);
    expect(res.json.outcome).toBe('ACCEPTED');
    expect(store.snapshot().eventStats('UNIT-M100')).toMatchObject({ updatesAccepted: 1, updatesIgnored: 0 });
  });

  it('does not double-count when the reject response is lost', async () => {
    const { store, deps } = harness();
    store.injectNext('LOST_RESPONSE');
    const res = await post(deps, '{', 'a');
    expect(res.statusCode).toBe(400);
    expect(store.snapshot().updatesRejected).toBe(1);
  });

  it('re-reads after losing a create race and then advances', async () => {
    const { store, deps } = harness();
    store.interceptNext(async () => {
      await store.createAthlete(
        { eventId: 'UNIT-M100', bib: 'AUS-1147', lane: 3, revision: 5, status: 'OFFICIAL', timeMs: 10105 },
        'other',
      );
    });
    const res = await post(deps, body({ revision: 6, status: 'PROVISIONAL' }), 'me');
    expect(res.json.outcome).toBe('ACCEPTED');
    expect(store.snapshot().results('UNIT-M100')[0]).toMatchObject({ revision: 6, status: 'PROVISIONAL' });
    expect(store.snapshot().eventStats('UNIT-M100').updatesAccepted).toBe(2);
  });

  it('returns 503 after 8 conflicts and counts nothing', async () => {
    const { store, lines, deps } = harness();
    for (let i = 0; i < 8; i++) store.injectNext('CONFLICT');
    const res = await post(deps, body(), 'a');
    expect(res.statusCode).toBe(503);
    expect(res.json).toEqual({ outcome: 'FAILED', requestId: 'a' });
    expect(store.snapshot().events).toEqual([]);
    expect(store.snapshot().updatesRejected).toBe(0);
    expect(lines.some((l) => l.level === 'ERROR')).toBe(true);
    expect(lines.some((l) => l.ProcessingFailures === 1)).toBe(true);
  });

  it('returns the stored rejection when this requestId was already rejected', async () => {
    const store: Store = {
      getAthlete: async () => undefined,
      createAthlete: async () => ({ kind: 'ALREADY_PROCESSED', outcome: 'REJECTED' }),
      advanceAthlete: async () => ({ kind: 'COMMITTED' }),
      recordIgnored: async () => ({ kind: 'COMMITTED' }),
      recordRejected: async () => ({ kind: 'COMMITTED' }),
    };
    const { deps } = harness(store);
    const res = await post(deps, body(), 'a');
    expect(res.statusCode).toBe(400);
    expect(res.json).toEqual({ outcome: 'REJECTED', requestId: 'a', errors: [] });
  });

  it('retries a transient error', async () => {
    const { store, deps } = harness();
    store.injectNext('TRANSIENT');
    const res = await post(deps, body(), 'a');
    expect(res.json.outcome).toBe('ACCEPTED');
    expect(store.snapshot().eventStats('UNIT-M100').updatesAccepted).toBe(1);
  });

  it('rethrows a non-retryable store error', async () => {
    const store: Store = {
      getAthlete: async () => { throw new Error('boom'); },
      createAthlete: async () => ({ kind: 'COMMITTED' }),
      advanceAthlete: async () => ({ kind: 'COMMITTED' }),
      recordIgnored: async () => ({ kind: 'COMMITTED' }),
      recordRejected: async () => ({ kind: 'COMMITTED' }),
    };
    const { deps } = harness(store);
    await expect(post(deps, body(), 'a')).rejects.toThrow('boom');
  });
});

describe('processor — logging', () => {
  it('emits exactly one outcome line per update, and every line for a bib carries the trace fields', async () => {
    const { lines, deps } = harness();
    await post(deps, body({ revision: 1 }), 'r1');
    await post(deps, body({ revision: 2, status: 'CONFIRMED' }), 'r2');
    const forBib = lines.filter((l) => l.bib === 'AUS-1147');
    expect(forBib.filter((l) => l.outcome)).toHaveLength(2);
    for (const line of forBib) {
      expect(line.eventId).toBe('UNIT-M100');
      expect(line.bib).toBe('AUS-1147');
      expect(line.requestId).toBeTruthy();
    }
  });
});
