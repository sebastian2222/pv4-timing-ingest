/**
 * Black-box harness against a DEPLOYED stack — roughly what RWS will run.
 *
 *   INGEST_URL=https://.../timing \
 *   GRAPHQL_URL=https://....appsync-api.ap-southeast-2.amazonaws.com/graphql \
 *   API_KEY=da2-... \
 *   npm run test:e2e
 *
 * Skipped automatically when the env vars are absent.
 * Sends sequentially, so the reference model's accepted/ignored split is deterministic.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ReferenceStore } from '../../src/model';
import { makeScenario } from '../../src/scenario';

const { INGEST_URL, GRAPHQL_URL, API_KEY } = process.env;
const live = Boolean(INGEST_URL && GRAPHQL_URL && API_KEY);
const RUN = `T${Date.now().toString(36)}`; // unique per run: never collide with old data

async function post(body: string, contentType: string | null = 'application/json') {
  const headers: Record<string, string> = {};
  if (contentType) headers['content-type'] = contentType;
  const r = await fetch(INGEST_URL!, { method: 'POST', headers, body });
  return r.status;
}

async function gql<T>(query: string, variables: object = {}): Promise<T> {
  const r = await fetch(GRAPHQL_URL!, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY! },
    body: JSON.stringify({ query, variables }),
  });
  const j = (await r.json()) as { data?: T; errors?: unknown[] };
  if (j.errors?.length) throw new Error(JSON.stringify(j.errors));
  return j.data!;
}

const Q_RESULTS = `query($e:ID!){ results(eventId:$e){ bib lane revision status timeMs } }`;
const Q_STATS = `query($e:ID!){ eventStats(eventId:$e){ eventId athletesTracked updatesAccepted updatesIgnored } }`;
const Q_REJ = `{ updatesRejected }`;
const Q_EVENTS = `{ events }`;

const sortByBib = <T extends { bib: string }>(xs: T[]) => [...xs].sort((a, b) => a.bib.localeCompare(b.bib));

describe.skipIf(!live)('deployed stack', () => {
  let rejectedBefore = 0;
  beforeAll(async () => {
    rejectedBefore = (await gql<{ updatesRejected: number }>(Q_REJ)).updatesRejected;
  });

  it('schema contract: an unknown event returns zeros and [], not null or an error', async () => {
    const e = `${RUN}-NEVER-SENT`;
    expect((await gql<any>(Q_RESULTS, { e })).results).toEqual([]);
    expect((await gql<any>(Q_STATS, { e })).eventStats).toEqual({
      eventId: e, athletesTracked: 0, updatesAccepted: 0, updatesIgnored: 0,
    });
  });

  it('worked example — read immediately after the last POST (no sleep)', async () => {
    const eventId = `${RUN}-WORKED`;
    const seq: [number, string][] = [[1, 'PROVISIONAL'], [3, 'OFFICIAL'], [2, 'CONFIRMED'], [3, 'OFFICIAL'], [3, 'CONFIRMED'], [4, 'PROVISIONAL']];
    for (const [revision, status] of seq) {
      const code = await post(JSON.stringify({ eventId, bib: 'AUS-1147', lane: 3, revision, status, timeMs: 10105, recordedAt: 'x' }));
      expect(code, 'valid updates (applied OR ignored) must get 2xx').toBeLessThan(300);
    }
    // If this fails but passes after a delay, you have an eventual-consistency problem the harness will hit.
    expect((await gql<any>(Q_RESULTS, { e: eventId })).results).toEqual([
      { bib: 'AUS-1147', lane: 3, revision: 4, status: 'PROVISIONAL', timeMs: 10105 },
    ]);
    expect((await gql<any>(Q_STATS, { e: eventId })).eventStats).toMatchObject({
      athletesTracked: 1, updatesAccepted: 3, updatesIgnored: 3,
    });
    expect((await gql<{ events: string[] }>(Q_EVENTS)).events).toContain(eventId);
  });

  it('randomised feed with duplicates, reordering and ~10% corruption matches the reference model', async () => {
    const ids = [`${RUN}-M100`, `${RUN}-W200`];
    const sc = makeScenario({ seed: 20260926, eventIds: ids, athletesPerEvent: 8, maxRevision: 5, dupRate: 0.3, corruptRate: 0.1 });
    const ref = new ReferenceStore();
    for (const raw of sc.feed) {
      ref.ingest(raw);
      await post(JSON.stringify(raw));
    }
    // Edge-rejected bodies: not JSON at all. Must count exactly like post-accept rejections.
    for (const bad of ['{"eventId":', 'not json', '']) {
      ref.rejectUnparseable(bad);
      await post(bad);
    }

    for (const e of ids) {
      expect(sortByBib((await gql<any>(Q_RESULTS, { e })).results)).toEqual(sortByBib(ref.results(e)));
      expect((await gql<any>(Q_STATS, { e })).eventStats).toEqual(ref.eventStats(e));
    }
    const rejectedAfter = (await gql<{ updatesRejected: number }>(Q_REJ)).updatesRejected;
    expect(rejectedAfter - rejectedBefore).toBe(ref.updatesRejected());
  }, 180_000);

  it('a corrupt update carrying a new eventId does not create a phantom event', async () => {
    const eventId = `${RUN}-PHANTOM`;
    await post(JSON.stringify({ eventId, bib: 'X', lane: 1, revision: 1, status: 'official', timeMs: 1 }));
    expect((await gql<{ events: string[] }>(Q_EVENTS)).events).not.toContain(eventId);
  });

  it('concurrent burst for one bib: final state is still the max revision', async () => {
    const eventId = `${RUN}-RACE`;
    const revs = Array.from({ length: 20 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
    await Promise.all(revs.map((revision) =>
      post(JSON.stringify({ eventId, bib: 'JAM-1', lane: 4, revision, status: 'CONFIRMED', timeMs: 9580 + revision }))));
    const [r] = (await gql<any>(Q_RESULTS, { e: eventId })).results;
    expect(r.revision).toBe(20);
    const st = (await gql<any>(Q_STATS, { e: eventId })).eventStats;
    expect(st.updatesAccepted + st.updatesIgnored).toBe(20); // split depends on arrival order; total does not
  }, 60_000);

  it('an alternating-status feed ends on the highest revision', async () => {
    const eventId = `${RUN}-ALT`;
    const ref = new ReferenceStore();
    for (let revision = 1; revision <= 12; revision++) {
      const raw = {
        eventId, bib: 'KEN-2', lane: 5, revision,
        status: revision % 2 === 0 ? 'OFFICIAL' : 'PROVISIONAL',
        timeMs: 10000 + revision,
      };
      ref.ingest(raw);
      expect(await post(JSON.stringify(raw))).toBeLessThan(300);
    }
    expect((await gql<any>(Q_RESULTS, { e: eventId })).results).toEqual(ref.results(eventId));
  });

  it('fifty updates across ten bibs match the oracle, three times', async () => {
    for (let round = 0; round < 3; round++) {
      const eventId = `${RUN}-PAR-${round}`;
      const updates = [];
      for (let bib = 1; bib <= 10; bib++) {
        for (let revision = 1; revision <= 5; revision++) {
          updates.push({
            eventId, bib: `B${bib}`, lane: bib, revision, status: 'CONFIRMED', timeMs: 9000 + bib * 10 + revision,
          });
        }
      }
      const ref = new ReferenceStore();
      for (const raw of updates) ref.ingest(raw);
      await Promise.all(updates.map((raw) => post(JSON.stringify(raw))));
      expect(sortByBib((await gql<any>(Q_RESULTS, { e: eventId })).results)).toEqual(sortByBib(ref.results(eventId)));
      const st = (await gql<any>(Q_STATS, { e: eventId })).eventStats;
      expect(st.updatesAccepted + st.updatesIgnored).toBe(updates.length);
    }
  }, 120_000);

  it('still processes text/plain and a missing content type', async () => {
    const eventId = `${RUN}-CT`;
    const raw = (bib: string, revision: number) => JSON.stringify({
      eventId, bib, lane: 1, revision, status: 'PROVISIONAL', timeMs: 11000,
    });
    expect(await post(raw('CT-1', 1), 'text/plain')).toBeLessThan(300);
    expect(await post(raw('CT-2', 1), null)).toBeLessThan(300);
    const bibs = sortByBib((await gql<any>(Q_RESULTS, { e: eventId })).results).map((r: { bib: string }) => r.bib);
    expect(bibs).toEqual(['CT-1', 'CT-2']);
  });

  it('rejects numeric strings, floats and a 2^31 value, and counts each rejection', async () => {
    const before = (await gql<{ updatesRejected: number }>(Q_REJ)).updatesRejected;
    const eventId = `${RUN}-BADNUM`;
    const bads = [
      { eventId, bib: 'A', lane: '3', revision: 1, status: 'PROVISIONAL', timeMs: 1000 },
      { eventId, bib: 'A', lane: 1.5, revision: 1, status: 'PROVISIONAL', timeMs: 1000 },
      { eventId, bib: 'A', lane: 1, revision: 1, status: 'PROVISIONAL', timeMs: 2 ** 31 },
    ];
    for (const bad of bads) expect(await post(JSON.stringify(bad))).toBe(400);
    const after = (await gql<{ updatesRejected: number }>(Q_REJ)).updatesRejected;
    expect(after - before).toBe(bads.length);
    expect((await gql<{ events: string[] }>(Q_EVENTS)).events).not.toContain(eventId);
  });

  it('counts the same body posted as two requests: one accepted, one ignored', async () => {
    const eventId = `${RUN}-DUP`;
    const raw = JSON.stringify({ eventId, bib: 'A', lane: 1, revision: 1, status: 'PROVISIONAL', timeMs: 1000 });
    expect(await post(raw)).toBeLessThan(300);
    expect(await post(raw)).toBeLessThan(300);
    expect((await gql<any>(Q_STATS, { e: eventId })).eventStats).toMatchObject({
      updatesAccepted: 1, updatesIgnored: 1, athletesTracked: 1,
    });
  });
});
