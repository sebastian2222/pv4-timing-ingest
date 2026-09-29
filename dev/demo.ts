export {};
/**
 * Demo script: drives a stack (local or deployed) through a realistic semi-final,
 * including duplicates, a stale update, corrupt payloads and a jury reopening a result.
 *
 *   INGEST_URL=http://localhost:4000/timing npx tsx dev/demo.ts [phase]
 *   phase = "race" (default) | "reopen"
 */
const INGEST = process.env.INGEST_URL ?? 'http://localhost:4000/timing';
const EVENT = process.env.EVENT_ID ?? 'DEMO-ATH-M100M-SF2';
const phase = process.argv[2] ?? 'race';

const field = [
  ['JAM-0412', 4, 9871], ['USA-2201', 5, 9884], ['AUS-1147', 3, 10105], ['GBR-0930', 6, 9902],
  ['CAN-1188', 7, 9947], ['RSA-0557', 2, 10021], ['JPN-0719', 8, 10033], ['ITA-0346', 1, 10118],
] as const;

async function post(body: unknown) {
  const r = await fetch(INGEST, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return r.status;
}
const u = (bib: string, lane: number, revision: number, status: string, timeMs: number) =>
  ({ eventId: EVENT, bib, lane, revision, status, timeMs, recordedAt: new Date().toISOString() });

if (phase === 'race') {
  for (const [bib, lane, t] of field) await post(u(bib, lane, 1, 'PROVISIONAL', t));
  for (const [bib, lane, t] of field) await post(u(bib, lane, 2, 'CONFIRMED', t));
  for (const [bib, lane, t] of field.slice(0, 6)) await post(u(bib, lane, 3, 'OFFICIAL', t));
  await post(u('AUS-1147', 3, 3, 'OFFICIAL', 10105));       // duplicate → ignored
  await post(u('AUS-1147', 3, 2, 'CONFIRMED', 10105));      // late stale copy → ignored
  await post({ ...u('ZZZ-9999', 9, 1, 'official', 9000) }); // corrupt → rejected, no phantom
  await post('{"eventId":"' + EVENT + '","bib":');          // truncated → rejected
} else {
  // Jury upholds a protest against USA-2201: result reopened, then a corrected time.
  await post(u('USA-2201', 5, 4, 'PROVISIONAL', 9889));
  await post(u('JPN-0719', 8, 3, 'OFFICIAL', 10033));
}
console.log(`demo phase "${phase}" sent to ${INGEST}`);
