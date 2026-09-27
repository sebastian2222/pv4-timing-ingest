import { describe, it, expect, beforeEach } from 'vitest';
import { ReferenceStore } from '../src/model';
import { makeScenario, shuffle, mulberry32 } from '../src/scenario';

const EV = 'WC26-ATH-M100M-SF2';
const u = (bib: string, revision: number, status: string, extra: object = {}) => ({
  eventId: EV, bib, lane: 3, revision, status, timeMs: 10000 + revision, recordedAt: 'x', ...extra,
});

let s: ReferenceStore;
beforeEach(() => { s = new ReferenceStore(); });

describe('the worked example from the brief — must match exactly', () => {
  it('AUS-1147: 3 accepted, 3 ignored, ends PROVISIONAL rev 4', () => {
    const outcomes = [
      s.ingest(u('AUS-1147', 1, 'PROVISIONAL')),
      s.ingest(u('AUS-1147', 3, 'OFFICIAL')),
      s.ingest(u('AUS-1147', 2, 'CONFIRMED')),
      s.ingest(u('AUS-1147', 3, 'OFFICIAL')),
      s.ingest(u('AUS-1147', 3, 'CONFIRMED')),
      s.ingest(u('AUS-1147', 4, 'PROVISIONAL')),
    ];
    expect(outcomes).toEqual(['ACCEPTED', 'ACCEPTED', 'IGNORED', 'IGNORED', 'IGNORED', 'ACCEPTED']);
    expect(s.results(EV)).toEqual([
      { bib: 'AUS-1147', lane: 3, revision: 4, status: 'PROVISIONAL', timeMs: 10004 },
    ]);
    expect(s.eventStats(EV)).toEqual({
      eventId: EV, athletesTracked: 1, updatesAccepted: 3, updatesIgnored: 3,
    });
    expect(s.updatesRejected()).toBe(0);
  });

  it('after the 3rd update the stored state is still OFFICIAL rev 3 (no flip-back)', () => {
    s.ingest(u('AUS-1147', 1, 'PROVISIONAL'));
    s.ingest(u('AUS-1147', 3, 'OFFICIAL'));
    s.ingest(u('AUS-1147', 2, 'CONFIRMED'));
    expect(s.results(EV)[0]).toMatchObject({ revision: 3, status: 'OFFICIAL' });
  });
});

describe('ordering is per bib, per event', () => {
  it("one athlete's revisions do not affect another's", () => {
    s.ingest(u('A', 10, 'OFFICIAL'));
    expect(s.ingest(u('B', 1, 'PROVISIONAL'))).toBe('ACCEPTED');
    expect(s.eventStats(EV).athletesTracked).toBe(2);
  });

  it('lane is not an ordering signal', () => {
    s.ingest(u('A', 2, 'CONFIRMED', { lane: 1 }));
    expect(s.ingest(u('A', 1, 'PROVISIONAL', { lane: 8 }))).toBe('IGNORED');
  });

  it('recordedAt is not an ordering signal', () => {
    s.ingest(u('A', 2, 'CONFIRMED', { recordedAt: '2000-01-01T00:00:00Z' }));
    expect(s.ingest(u('A', 1, 'PROVISIONAL', { recordedAt: '2099-01-01T00:00:00Z' }))).toBe('IGNORED');
  });

  it('the same bib in two different events is two different athletes', () => {
    s.ingest(u('AUS-1147', 5, 'OFFICIAL'));
    expect(s.ingest({ ...u('AUS-1147', 1, 'PROVISIONAL'), eventId: 'OTHER' })).toBe('ACCEPTED');
    expect(s.eventStats('OTHER')).toMatchObject({ athletesTracked: 1, updatesAccepted: 1, updatesIgnored: 0 });
    expect(s.eventStats(EV)).toMatchObject({ athletesTracked: 1, updatesAccepted: 1 });
  });

  it('first-seen revision can be anything ≥ 1, not just 1', () => {
    expect(s.ingest(u('A', 42, 'CONFIRMED'))).toBe('ACCEPTED');
  });

  it('the latest applied update wins for every field, including timeMs and lane', () => {
    s.ingest(u('A', 1, 'PROVISIONAL', { timeMs: 9990, lane: 4 }));
    s.ingest(u('A', 2, 'CONFIRMED', { timeMs: 9987, lane: 4 }));
    expect(s.results(EV)[0]).toEqual({ bib: 'A', lane: 4, revision: 2, status: 'CONFIRMED', timeMs: 9987 });
  });

  it('does not leak recordedAt or extra fields into results', () => {
    s.ingest({ ...u('A', 1, 'PROVISIONAL'), secret: 1 });
    expect(Object.keys(s.results(EV)[0]).sort()).toEqual(['bib', 'lane', 'revision', 'status', 'timeMs']);
  });
});

describe('validation inside the pipeline', () => {
  it('a corrupt update increments updatesRejected and nothing else', () => {
    s.ingest(u('A', 1, 'PROVISIONAL'));
    expect(s.ingest(u('A', 2, 'official'))).toBe('REJECTED');
    expect(s.updatesRejected()).toBe(1);
    expect(s.eventStats(EV)).toMatchObject({ updatesAccepted: 1, updatesIgnored: 0 });
    expect(s.results(EV)[0].revision).toBe(1);
  });

  it('a corrupt update does not create a phantom athlete', () => {
    s.ingest(u('GHOST', 1, 'PROVISIONAL', { timeMs: -5 }));
    expect(s.results(EV)).toEqual([]);
  });

  it('a corrupt update for a never-seen event does not create a phantom event', () => {
    s.ingest({ ...u('A', 1, 'PROVISIONAL'), eventId: 'PHANTOM', status: 'NOPE' });
    expect(s.events()).toEqual([]);
  });

  it('a corrupt update does not block the good updates behind it', () => {
    s.ingest('not even json-shaped');
    s.ingest(null);
    expect(s.ingest(u('A', 1, 'PROVISIONAL'))).toBe('ACCEPTED');
  });

  it('keeps the rejected payload and the reasons, so it does not vanish silently', () => {
    s.ingest({ ...u('A', 1, 'PROVISIONAL'), revision: 0 });
    expect(s.rejectedPayloads()).toHaveLength(1);
    expect(s.rejectedPayloads()[0].errors.map((e) => e.field)).toContain('revision');
  });

  it('counts unparseable bodies as rejected too (the "edge 4xx" path)', () => {
    s.rejectUnparseable('{"broken');
    expect(s.updatesRejected()).toBe(1);
  });
});

describe('idempotency of the delivery itself (queue redelivery / Lambda retry)', () => {
  it('the same delivery processed twice counts once — it must NOT be counted as ignored', () => {
    const d = u('A', 1, 'PROVISIONAL');
    expect(s.ingest(d, 'req-123')).toBe('ACCEPTED');
    expect(s.ingest(d, 'req-123')).toBe('ALREADY_PROCESSED');
    expect(s.eventStats(EV)).toMatchObject({ updatesAccepted: 1, updatesIgnored: 0 });
  });

  it('two separate deliveries of the same payload: the second is a real duplicate → ignored', () => {
    const d = u('A', 1, 'PROVISIONAL');
    s.ingest(d, 'req-1');
    expect(s.ingest(d, 'req-2')).toBe('IGNORED');
    expect(s.eventStats(EV)).toMatchObject({ updatesAccepted: 1, updatesIgnored: 1 });
  });

  it('a redelivered rejection is not double-counted', () => {
    s.ingest({ bad: true }, 'req-9');
    s.ingest({ bad: true }, 'req-9');
    expect(s.updatesRejected()).toBe(1);
  });
});

describe('reads for things that do not exist — non-null contract', () => {
  it('eventStats for an unknown event is zeros, not null', () => {
    expect(s.eventStats('NOPE')).toEqual({ eventId: 'NOPE', athletesTracked: 0, updatesAccepted: 0, updatesIgnored: 0 });
  });
  it('results for an unknown event is an empty list', () => {
    expect(s.results('NOPE')).toEqual([]);
  });
  it('updatesRejected starts at 0', () => {
    expect(s.updatesRejected()).toBe(0);
  });
  it('events lists every event with stored state, once each', () => {
    s.ingest(u('A', 1, 'PROVISIONAL'));
    s.ingest(u('B', 1, 'PROVISIONAL'));
    s.ingest({ ...u('A', 1, 'PROVISIONAL'), eventId: 'W-100M-F' });
    expect(s.events().sort()).toEqual([EV, 'W-100M-F'].sort());
  });
});

describe('invariants over randomised feeds (what a harness will actually throw)', () => {
  const seeds = Array.from({ length: 200 }, (_, i) => i + 1);

  it.each(seeds)('seed %i: every update lands in exactly one bucket', (seed) => {
    const sc = makeScenario({ seed, eventIds: ['E1', 'E2'], athletesPerEvent: 8, maxRevision: 6, dupRate: 0.3, corruptRate: 0.1 });
    for (const raw of sc.feed) s.ingest(raw);

    const accepted = sc.eventIds.reduce((n, e) => n + s.eventStats(e).updatesAccepted, 0);
    const ignored = sc.eventIds.reduce((n, e) => n + s.eventStats(e).updatesIgnored, 0);
    expect(accepted + ignored + s.updatesRejected()).toBe(sc.feed.length);
    expect(s.updatesRejected()).toBe(sc.corruptCount);
  });

  it.each(seeds)('seed %i: final state is the highest revision per bib, whatever the arrival order', (seed) => {
    const sc = makeScenario({ seed, eventIds: ['E1'], athletesPerEvent: 8, maxRevision: 6, dupRate: 0.3, corruptRate: 0.1 });
    for (const raw of sc.feed) s.ingest(raw);
    const got = Object.fromEntries(s.results('E1').map((r) => [r.bib, r]));
    expect(got).toEqual(sc.expectedFinal['E1']);
  });

  it.each(seeds)('seed %i: the final state is identical under any reordering of the same feed', (seed) => {
    const sc = makeScenario({ seed, eventIds: ['E1'], athletesPerEvent: 6, maxRevision: 5, dupRate: 0.3, corruptRate: 0.1 });
    const a = new ReferenceStore();
    const b = new ReferenceStore();
    sc.feed.forEach((x) => a.ingest(x));
    shuffle(sc.feed, mulberry32(seed * 7919)).forEach((x) => b.ingest(x));
    const byBib = (st: ReferenceStore) => st.results('E1').sort((x, y) => x.bib.localeCompare(y.bib));
    expect(byBib(b)).toEqual(byBib(a));
    // Totals (accepted + ignored) are order-invariant; the split between them is NOT.
    const tot = (st: ReferenceStore) => st.eventStats('E1').updatesAccepted + st.eventStats('E1').updatesIgnored;
    expect(tot(b)).toBe(tot(a));
  });

  it('in-order delivery of N distinct revisions accepts all N; reversed accepts 1', () => {
    for (let r = 1; r <= 5; r++) s.ingest(u('A', r, 'PROVISIONAL'));
    expect(s.eventStats(EV)).toMatchObject({ updatesAccepted: 5, updatesIgnored: 0 });
    const t = new ReferenceStore();
    for (let r = 5; r >= 1; r--) t.ingest(u('A', r, 'PROVISIONAL'));
    expect(t.eventStats(EV)).toMatchObject({ updatesAccepted: 1, updatesIgnored: 4 });
  });
});
