import { describe, expect, it } from 'vitest';
import { InMemoryDeadLetter } from '../src/deadLetter';
import { FakeStore } from '../src/fakeStore';
import { ReferenceStore } from '../src/model';
import { createLogger } from '../src/obs';
import { processUpdate } from '../src/processor';
import { makeScenario, mulberry32 } from '../src/scenario';
import type { Store, TxResult } from '../src/store';

const log = createLogger({ service: 'pv4-ingest' }, { sink: () => {} });
const deadLetter = new InMemoryDeadLetter();
const sleep = async () => {};

async function send(store: Store, raw: unknown, requestId: string) {
  const res = await processUpdate(
    { body: JSON.stringify(raw), requestId },
    { store, deadLetter, log, sleep },
  );
  if (res.statusCode === 503) throw new Error(`processor gave up on ${requestId}`);
}

function oracle(feed: unknown[]) {
  const ref = new ReferenceStore();
  for (const raw of feed) ref.ingest(raw);
  return ref;
}

function sortedResults(rows: { bib: string; lane: number; revision: number; status: string; timeMs: number }[]) {
  return [...rows]
    .map(({ bib, lane, revision, status, timeMs }) => ({ bib, lane, revision, status, timeMs }))
    .sort((a, b) => a.bib.localeCompare(b.bib));
}

function assertSameState(fake: FakeStore, ref: ReferenceStore, eventIds: string[]) {
  expect([...fake.snapshot().events].sort()).toEqual([...ref.events()].sort());
  for (const eventId of eventIds) {
    expect(sortedResults(fake.snapshot().results(eventId))).toEqual(sortedResults(ref.results(eventId)));
    expect(fake.snapshot().eventStats(eventId)).toEqual(ref.eventStats(eventId));
  }
  expect(fake.snapshot().updatesRejected).toBe(ref.updatesRejected());
}

describe('processor vs reference store', () => {
  it('matches the oracle for 300 misbehaving feeds', async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const sc = makeScenario({
        seed, athletesPerEvent: 8, maxRevision: 6, dupRate: 0.3, corruptRate: 0.1, eventIds: ['E1', 'E2'],
      });
      const fake = new FakeStore();
      const ref = oracle(sc.feed);
      for (let i = 0; i < sc.feed.length; i++) await send(fake, sc.feed[i], `s${seed}-${i}`);
      assertSameState(fake, ref, sc.eventIds);

      let accepted = 0;
      let ignored = 0;
      for (const eventId of sc.eventIds) {
        const st = ref.eventStats(eventId);
        accepted += st.updatesAccepted;
        ignored += st.updatesIgnored;
      }
      expect(accepted + ignored + ref.updatesRejected()).toBe(sc.feed.length);
    }
  }, 120_000);

  it('still matches the oracle when transactions fail and are retried', async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const sc = makeScenario({
        seed, athletesPerEvent: 8, maxRevision: 6, dupRate: 0.3, corruptRate: 0.1, eventIds: ['E1', 'E2'],
      });
      const fake = new FakeStore();
      const rnd = mulberry32(seed + 10_000);
      const ref = oracle(sc.feed);

      for (let i = 0; i < sc.feed.length; i++) {
        let injected = 0;
        const store: Store = {
          getAthlete: (eventId, bib) => fake.getAthlete(eventId, bib),
          createAthlete: (u, id) => hit(() => fake.createAthlete(u, id)),
          advanceAthlete: (u, id) => hit(() => fake.advanceAthlete(u, id)),
          recordIgnored: (u, id) => hit(() => fake.recordIgnored(u, id)),
          recordRejected: (id) => hit(() => fake.recordRejected(id)),
        };
        const hit = (op: () => Promise<TxResult>): Promise<TxResult> => {
          // Cap injected faults so eight in a row cannot turn a good update into a 503.
          if (injected < 3 && rnd() < 0.2) {
            injected += 1;
            const kinds = ['CONFLICT', 'LOST_RESPONSE', 'TRANSIENT'] as const;
            fake.injectNext(kinds[Math.floor(rnd() * kinds.length)]);
          }
          return op();
        };
        await send(store, sc.feed[i], `f${seed}-${i}`);
      }
      assertSameState(fake, ref, sc.eventIds);
    }
  }, 120_000);

  it('keeps the final results under concurrent batches, and the counter total', async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const sc = makeScenario({
        seed, athletesPerEvent: 8, maxRevision: 6, dupRate: 0.3, corruptRate: 0.1, eventIds: ['E1', 'E2'],
      });
      const fake = new FakeStore();
      const ref = oracle(sc.feed);
      for (let i = 0; i < sc.feed.length; i += 10) {
        const batch = sc.feed.slice(i, i + 10);
        await Promise.all(batch.map((raw, j) => send(fake, raw, `c${seed}-${i + j}`)));
      }
      expect([...fake.snapshot().events].sort()).toEqual([...ref.events()].sort());
      expect(fake.snapshot().updatesRejected).toBe(ref.updatesRejected());
      for (const eventId of sc.eventIds) {
        expect(sortedResults(fake.snapshot().results(eventId))).toEqual(sortedResults(ref.results(eventId)));
        const got = fake.snapshot().eventStats(eventId);
        const want = ref.eventStats(eventId);
        expect(got.athletesTracked).toBe(want.athletesTracked);
        expect(got.updatesAccepted + got.updatesIgnored).toBe(want.updatesAccepted + want.updatesIgnored);
      }
    }
  }, 120_000);
});
