/**
 * Deterministic generator of misbehaving timing feeds — the kind of data a harness
 * will throw at you. Seeded, so any failure is reproducible.
 */
import { STATUSES, type Status } from './validate';
import type { Result } from './model';

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(xs: readonly T[], rnd: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Every flavour of corruption the validation table allows for. */
export const CORRUPTIONS: ((u: Record<string, unknown>) => unknown)[] = [
  (u) => ({ ...u, eventId: '' }),
  (u) => ({ ...u, eventId: undefined }),
  (u) => ({ ...u, bib: '' }),
  (u) => ({ ...u, bib: 1147 }),
  (u) => ({ ...u, lane: '3' }),
  (u) => ({ ...u, lane: 3.5 }),
  (u) => ({ ...u, lane: null }),
  (u) => ({ ...u, revision: 0 }),
  (u) => ({ ...u, revision: -2 }),
  (u) => ({ ...u, revision: '2' }),
  (u) => ({ ...u, revision: 1.5 }),
  (u) => ({ ...u, status: 'official' }),
  (u) => ({ ...u, status: 'FINAL' }),
  (u) => ({ ...u, status: 'PROVISIONAL|OFFICIAL' }),
  (u) => ({ ...u, status: null }),
  (u) => ({ ...u, timeMs: 0 }),
  (u) => ({ ...u, timeMs: -10105 }),
  (u) => ({ ...u, timeMs: '10105' }),
  (u) => ({ ...u, timeMs: 10.5 }),
  () => ({}),
  () => null,
  () => [],
  () => 'garbage',
];

export interface Scenario {
  eventIds: string[];
  feed: unknown[];
  corruptCount: number;
  expectedFinal: Record<string, Record<string, Result>>;
}

export function makeScenario(o: {
  seed: number;
  eventIds: string[];
  athletesPerEvent: number;
  maxRevision: number;
  dupRate: number;
  corruptRate: number;
}): Scenario {
  const rnd = mulberry32(o.seed);
  const clean: Record<string, unknown>[] = [];
  const expectedFinal: Scenario['expectedFinal'] = {};

  for (const eventId of o.eventIds) {
    expectedFinal[eventId] = {};
    for (let i = 0; i < o.athletesPerEvent; i++) {
      const bib = `BIB-${String(i + 1).padStart(3, '0')}`;
      const lane = i + 1;
      const revs = 1 + Math.floor(rnd() * o.maxRevision);
      for (let revision = 1; revision <= revs; revision++) {
        const status = STATUSES[Math.floor(rnd() * 3)] as Status; // any status at any revision
        const timeMs = 9500 + Math.floor(rnd() * 1500);
        clean.push({ eventId, bib, lane, revision, status, timeMs, recordedAt: new Date(rnd() * 2e12).toISOString() });
        if (revision === revs) expectedFinal[eventId][bib] = { bib, lane, revision, status, timeMs };
      }
    }
  }

  const withDups = clean.flatMap((u) => (rnd() < o.dupRate ? [u, { ...u }] : [u]));
  let corruptCount = 0;
  const withCorrupt: unknown[] = [];
  for (const u of withDups) {
    withCorrupt.push(u);
    if (rnd() < o.corruptRate) {
      withCorrupt.push(CORRUPTIONS[Math.floor(rnd() * CORRUPTIONS.length)](u));
      corruptCount++;
    }
  }
  return { eventIds: o.eventIds, feed: shuffle(withCorrupt, rnd), corruptCount, expectedFinal };
}
