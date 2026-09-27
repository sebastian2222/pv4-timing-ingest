# PV4 Technical Assessment — Implementation Plan (TDD)

This plan is written to be executed by an AI coding agent (Cursor) and a human together.
Follow the phases **in order**. Every phase is **test-first**: write the failing tests, watch
them fail, make them pass, then run the phase gate. Do not start a phase until the
previous gate is green.

The goal is simple: **every harness check passes**, and every line can be explained in the
35-minute follow-up interview.

---

## 0. Rules for the agent (read before touching code)

1. **TDD loop, always.** Red → green → refactor. Write or extend a test *before* the code
   that makes it pass. Never write production code that no test exercises.
2. **Never weaken a test to make it pass.** If a test looks wrong, stop and explain why
   instead of editing it. The existing tests in `test/` encode the brief exactly.
3. **The GraphQL contract in `schema.graphql` is frozen.** Do not rename, reorder the
   meaning of, or change the nullability of anything in it. Additions go *alongside* it,
   and only in Phase 10 (optional).
4. **`src/validate.ts`, `src/decide.ts`, `src/parseBody.ts` and `src/model.ts` are the
   specification.** The processor must reuse `validate.ts`, `decide.ts` and `parseBody.ts`
   directly. `model.ts` (`ReferenceStore`) is the oracle the real system is compared against.
5. **`status` is never used to make a decision.** Only `revision` orders updates, only
   within a single `(eventId, bib)`. `lane` and `recordedAt` are never ordering signals.
6. **Every update received lands in exactly one counter**: `updatesAccepted` (per event),
   `updatesIgnored` (per event) or `updatesRejected` (pipeline-wide). Never zero, never two.
7. **Run the gate command at the end of each phase** and show its summary line to the human.
8. **The human always commits and is the only author. The agent never runs `git commit`,
   `git push`, `git tag`, `git rebase`, `git reset`, `git config`, or anything else that
   writes git history or identity.** The agent must not add `Co-authored-by` or any other
   AI attribution to commits, files, or code comments. At the end of each phase the agent
   **stops** and hands over:
   - the gate output (test summary line),
   - a short list of files changed and why,
   - a suggested commit message, e.g. `phase 3: processor core (tests green)`.
   The human reviews the diff (`git diff`), commits it themselves, and tells the agent to
   continue. Read-only git commands (`git status`, `git diff`, `git log`) are fine.
9. **Do not add dependencies** beyond the ones listed in this plan without saying why.
10. **Keep code explainable.** Prefer small, plain functions with a comment explaining *why*
    over clever abstractions.
11. **Region is `ap-southeast-2`** (Sydney) unless the human says otherwise.
12. If something in the brief is ambiguous and not covered by §2 below, **stop and ask** —
    do not guess silently.

---

## 1. What already exists (starting point)

Unpack `pv4-tdd.tar.gz` into the repo root. It contains, all green:

| Path | What it is | Status |
|---|---|---|
| `schema.graphql` | The exact required contract | Frozen |
| `src/validate.ts` | Field validation per the brief; returns all errors | Done, tested |
| `src/parseBody.ts` | HTTP body → JSON, never throws, handles base64/BOM | Done, tested |
| `src/decide.ts` | The ordering rule: apply iff no stored revision or incoming > stored | Done, tested |
| `src/model.ts` | `ReferenceStore`: in-memory reference implementation (the oracle) | Done, tested |
| `src/scenario.ts` | Seeded generator of misbehaving feeds (dups, shuffle, 23 corruptions) | Done |
| `src/obs.ts` | Structured JSON logger + CloudWatch EMF metrics | Done, tested |
| `infra/api.ts` | AppSync API with API key (360-day expiry) | Done, tested |
| `infra/results-site.ts` | S3 + CloudFront (OAC) + generated `config.json` | Done, tested |
| `infra/observability.ts` | Alarms, SNS, dashboard, saved Logs Insights queries | Done, tested (1 addition in Phase 7) |
| `web/index.html` | Results page, no build step | Done |
| `dev/local-stack.ts` | Local fake stack (ingest + GraphQL + page) on :4000 | Done |
| `dev/demo.ts` | Demo feed: a realistic race + jury reopen | Done |
| `test/e2e/harness.test.ts` | Black-box harness against a deployed stack | Done (skips without env vars) |
| `docs/SECTIONS-4-5.md` | How sections 4 and 5 are shown to reviewers | Done |

Check it works before starting:

```bash
npm install
npm test            # expect: all passed, e2e skipped
npx tsc -p .        # expect: no errors
```

---

## 2. Decisions already made (do not re-open)

These are recorded here so the agent does not re-decide them. Each goes into `DECISIONS.md`.

| # | Decision | Why |
|---|---|---|
| D1 | **Process synchronously** in the ingest Lambda. The HTTP response is only sent after state and counters are written. No SQS/Kinesis. | The harness may query immediately after posting. Async would make reads stale. |
| D2 | **All AppSync reads use `consistentRead: true`**, and no read uses a GSI. | Eventually consistent reads can miss a write from milliseconds ago. GSIs cannot be read consistently. |
| D3 | **Ordering enforced by DynamoDB conditional writes inside a transaction**, never by read-compare-write in Lambda alone. | Correct under concurrency. The read is an optimisation; the condition is the guarantee. |
| D4 | **State change and counter change are in the same `TransactWriteItems`.** | They can never disagree, even if Lambda dies mid-request. |
| D5 | **Every transaction also writes a delivery marker** `DELIVERY#{requestId}` with `attribute_not_exists`. | If a transaction commits but its response is lost and we retry, the marker makes the retry a no-op instead of a double count. |
| D6 | **Retry on `TransactionConflict` and on failed conditions**, re-reading state each time, up to 8 attempts with jittered backoff. | Parallel updates for one event all touch its stats item and will conflict. Not retrying loses updates. |
| D7 | Rejected updates: **count in DynamoDB (transaction), then store the raw payload in S3** `rejected/{date}/{requestId}.json`, 30-day lifecycle. Respond **400**. | Counting is what is scored, so it happens first and atomically. The payload must be retrievable afterwards. |
| D8 | Valid but stale/duplicate updates respond **200** with `outcome: "IGNORED"`. | They are not errors. |
| D9 | Integers must fit GraphQL `Int` (≤ 2³¹−1), else rejected. Whitespace-only `eventId`/`bib` rejected. `recordedAt` never validated. Extra fields ignored, never stored. | Already in `validate.ts`. An out-of-range int could never be served back. |
| D10 | **Strings stored exactly as sent** (no trimming, no case folding). `aus-1147` ≠ `AUS-1147`. | The brief gives no normalisation rule; changing data is riskier than not. |
| D11 | **Assumption:** revision is strictly increasing per `(eventId, bib)`, and **if a race is re-run, the timing system sends it under a new `eventId`** (e.g. `...-SF2-RERUN`). Revisions are never reset within one `eventId`. | A reset would make every new update look stale and be ignored. Pending confirmation from Rory (question sent). If he says otherwise, stop and re-plan. |
| D12 | API key expiry **360 days**. | AppSync default is 7 days; reviewers may test later than that. |
| D13 | Metrics dimensioned by `Service` only. `eventId`/`bib` are log fields, not dimensions. | Stays in the free tier; unbounded dimensions cost money. |
| D14 | Rejection-rate alarm (> 25%, ≥ 20 updates/min, 2 of 3 minutes) + processor error alarms. | ~10% corruption is normal per the brief, so alarm on the *rate*. |
| D15 | **Chosen: Refresh button (required) + 5 s auto-refresh checkbox.** Each refresh is **one** GraphQL request (events + results + eventStats + updatesRejected together), and auto-refresh pauses while the tab is hidden. Subscriptions (Phase 10) are *not* planned; mention them in DECISIONS.md as the production upgrade. | Brief requires re-fetch without reload. Polling is simple and has nothing to break. Cost is tiny: roughly 700 requests per hour per open, visible tab, a fraction of a cent. Push would be faster and cheaper at scale but adds a WebSocket client, stream Lambda and IAM auth that the harness never tests. |
| D16 | Non-POST methods and paths other than `/timing` return API Gateway's default 404 and are **not** counted. Bodies over API Gateway's 10 MB limit never reach Lambda and are not counted. | They are not updates. Listed as a known concession. |
| D17 | DynamoDB **on-demand** billing. | Harness bursts would throttle a small provisioned table; cost at this volume is cents. |
| D18 | Stack submitted **with all data wiped**, so `updatesRejected` is 0 at handover. | Our own testing must not pollute the pipeline-wide counter. |
| D19 | HTTP API stage throttling **rate 200/s, burst 400**, and confirm the account's Lambda concurrency quota is ≥ 100 before running the harness. | Caps the cost of someone spamming the public endpoint, while staying far above anything a harness sends. New AWS accounts can have a Lambda concurrency limit as low as 10, which would make parallel harness sends fail. |
| D20 | **Deployed URLs and the API key go only in the submission email, never in the public repo.** README says "see submission email". | A public repo is scraped by bots. Junk posted to the ingest URL would pollute the pipeline-wide counter before the harness runs. |
| D22 | Two extra correctness metrics, computed from the `getAthlete` read the processor already does: **`ResultsReopened`** (an ACCEPTED update whose status is lower than the stored status, i.e. the jury case) and **`ConflictingRevision`** (an update with the *same* revision as stored but different status/time/lane, meaning the venue sent two different truths for one revision). `ResultsReopened` is metric only. **`ConflictingRevision` gets an alarm (≥ 1 in 1 minute)**, because it means the displayed result may be wrong and only a human can resolve it. | The brief's real failure is "a result changing when it shouldn't". A reopen is legitimate but broadcast-critical, and a conflicting revision is an upstream bug that would otherwise be silently counted as a normal duplicate. |
| D21 | An **AWS Budget** of $5/month with an email alert at 80%, created before the first deploy. | The only way to find out about unexpected cost in time. |

---

## 3. Architecture

```
                        ┌──────────────────────── ingest (write) ──────────────────────────┐
 Timing feed ─POST /timing─▶ API Gateway HTTP API ─▶ Lambda "processor"
                                                      │ parseBody → validate → decide
                                                      │ TransactWriteItems (state + counters + delivery marker)
                                                      ├──────────────▶ DynamoDB table "pv4"
                                                      ├── rejected ─▶ S3 dead-letter bucket
                                                      └── JSON logs + EMF metrics ─▶ CloudWatch
                        └──────────────────────────────────────────────────────────────────┘

                        ┌──────────────────────── read ──────────────────────────────────────┐
 Harness / page ─GraphQL (x-api-key)─▶ AppSync ─JS resolvers, consistent reads─▶ DynamoDB
 Browser ─HTTPS─▶ CloudFront ─OAC─▶ S3 (index.html + config.json)
                        └──────────────────────────────────────────────────────────────────┘
```

### 3.1 DynamoDB single-table design (`pv4`, `pk` + `sk` strings, TTL attribute `ttl`)

| Item | `pk` | `sk` | Attributes |
|---|---|---|---|
| Athlete result | `EVENT#{eventId}` | `BIB#{bib}` | `eventId, bib, lane, revision, status, timeMs, updatedAt` |
| Event stats | `EVENT#{eventId}` | `STATS` | `eventId, updatesAccepted, updatesIgnored, athletesTracked` |
| Event registry | `EVENTS` | `EVENT#{eventId}` | `eventId, firstSeenAt` |
| Global stats | `GLOBAL` | `STATS` | `updatesRejected` |
| Delivery marker | `DELIVERY#{requestId}` | `DELIVERY` | `outcome, ttl` (24 h) |

Key safety: the prefixes are fixed and the user value always comes *after* them, so no
`eventId` or `bib` value (even one containing `#`) can collide with another item type.

### 3.2 The processor algorithm (the heart of the system)

```
processUpdate(rawEvent, requestId):
  parsed = parseBody(rawEvent)                         # never throws
  if !parsed.ok            → rejectedPath(reason)
  v = validateUpdate(parsed.value)
  if !v.ok                 → rejectedPath(v.errors)

  for attempt in 1..8:
    stored = getAthlete(eventId, bib, consistent=true)       # may be undefined
    try:
      if stored is undefined:
        tx CREATE:
          Put    athlete       condition attribute_not_exists(pk)
          Update event stats   ADD updatesAccepted 1, athletesTracked 1; SET eventId
          Put    registry      (no condition; idempotent)
          Put    delivery      condition attribute_not_exists(pk); outcome=ACCEPTED
        → ACCEPTED
      elif decide(stored.revision, revision) == APPLY:
        tx ADVANCE:
          Update athlete       SET all fields  condition #revision < :rev
          Update event stats   ADD updatesAccepted 1
          Put    delivery      condition attribute_not_exists(pk); outcome=ACCEPTED
        → ACCEPTED
      else:
        tx IGNORE:
          ConditionCheck athlete  condition #revision >= :rev
          Update event stats      ADD updatesIgnored 1
          Put    delivery         condition attribute_not_exists(pk); outcome=IGNORED
        → IGNORED
    catch TransactionCanceled(reasons):
      if reasons[delivery] == ConditionalCheckFailed → ALREADY_PROCESSED: return the stored outcome, count nothing
      if any reason is ConditionalCheckFailed or TransactionConflict → backoff(attempt), continue
      otherwise → rethrow
    catch retryable SDK error (throttle / network / 5xx after SDK retries) → backoff, continue
  → FAILED (log ERROR, metric ProcessingFailures, respond 503)

rejectedPath(errors):
  tx: Update GLOBAL/STATS ADD updatesRejected 1; Put delivery (outcome=REJECTED)
      (same retry loop; delivery ConditionalCheckFailed → ALREADY_PROCESSED)
  then best effort: S3 PutObject rejected/{yyyy-mm-dd}/{requestId}.json {raw, errors, receivedAt, requestId}
       (failure → log ERROR + metric DeadLetterWriteFailures; still respond 400)
  respond 400 { outcome: "REJECTED", requestId, errors }
```

Why each piece exists (the agent must preserve all of them):

- **The read (`getAthlete`)** only chooses which transaction to try and gives `storedRevision`
  for the logs. Correctness never depends on it, because every transaction re-checks its
  condition atomically.
- **The `ConditionCheck` in IGNORE** makes the decision atomic too. Revisions only grow, so
  it will essentially always pass, but it keeps the proof simple: every transaction
  validates the fact it relies on.
- **The delivery marker** handles the "committed but response lost" case. Without it a retry
  would re-read, see `revision == incoming`, and count the same update a second time as IGNORED.
- **`athletesTracked` is incremented only in CREATE**, whose condition guarantees the athlete
  did not exist. So it always equals the number of athlete items.

HTTP responses: `200 {outcome, requestId}` for ACCEPTED / IGNORED / ALREADY_PROCESSED,
`400 {outcome:"REJECTED", requestId, errors}`, `503 {outcome:"FAILED", requestId}`.

### 3.3 Reads (AppSync JS resolvers, `APPSYNC_JS` runtime)

| Field | Operation | Key / condition | Empty case |
|---|---|---|---|
| `events` | Query | `pk = "EVENTS"` | `[]` |
| `results(eventId)` | Query | `pk = "EVENT#"+eventId AND begins_with(sk, "BIB#")` | `[]` |
| `eventStats(eventId)` | GetItem | `pk = "EVENT#"+eventId, sk = "STATS"` | zeros, `eventId` echoed back |
| `updatesRejected` | GetItem | `pk = "GLOBAL", sk = "STATS"` | `0` |

All four: `consistentRead: true`. Queries use `limit: 1000` (see concessions).

---

## 4. Target repo layout

```
.
├── plan.md                    this file
├── README.md                  URLs, how to deploy, how to test, screenshots
├── DECISIONS.md               required by the brief (Phase 9)
├── schema.graphql             frozen contract
├── bin/pv4.ts                 CDK app entry
├── infra/
│   ├── api.ts                 (exists)
│   ├── results-site.ts        (exists)
│   ├── observability.ts       (exists; +1 alarm in Phase 7)
│   ├── data.ts                NEW: table + dead-letter bucket
│   ├── ingest.ts              NEW: processor Lambda + HTTP API
│   ├── resolvers.ts           NEW: AppSync data source + 4 resolvers
│   └── pv4-stack.ts           NEW: composes everything, outputs
├── resolvers/                 NEW: plain JS, deployed as-is
│   ├── events.js
│   ├── results.js
│   ├── eventStats.js
│   └── updatesRejected.js
├── src/
│   ├── validate.ts parseBody.ts decide.ts model.ts scenario.ts obs.ts   (exist)
│   ├── store.ts               NEW: Store port (interface) + result types
│   ├── fakeStore.ts           NEW: in-memory Store with fault injection (tests only)
│   ├── dynamoStore.ts         NEW: DynamoDB implementation of Store
│   ├── deadLetter.ts          NEW: S3 dead-letter writer (+ in-memory fake)
│   ├── processor.ts           NEW: processUpdate(), pure orchestration
│   └── handler.ts             NEW: Lambda entry; wires real deps
├── scripts/
│   ├── reset-data.ts          NEW: wipe all items (before submission)
│   └── smoke.sh               NEW: curl the deployed stack
├── dev/                       (exists)
├── web/index.html             (exists)
└── test/
    ├── (existing unit tests)
    ├── processor.test.ts      NEW
    ├── processor.differential.test.ts NEW
    ├── dynamoStore.test.ts    NEW (command shapes, aws-sdk-client-mock)
    ├── dynamoStore.local.test.ts NEW (DynamoDB Local; skipped without DDB_ENDPOINT)
    ├── handler.test.ts        NEW
    ├── resolvers.test.ts      NEW
    ├── stack.test.ts          NEW
    └── e2e/harness.test.ts    (exists; extended in Phase 8)
```

---

## 5. Phases

Timebox guide: the brief says at most 6 hours. Phases 1–9 are required (~4.5–5 h with the
existing code). Phase 10 is optional. If time runs short, **cut Phase 10 first**, never
Phases 3, 4, 8 or 9.

---

### Phase 1 — Repo setup (15 min)

**Do**
1. **Human:** `git init` (with your own name and email in git config). **Agent:** create
   `.gitignore` with `node_modules`, `cdk.out`, `cdk-outputs.json`, `.env*`,
   `screenshots/*.tmp`. `cdk-outputs.json` holds the live URLs and API key, which must
   never reach the public repo (D20).
2. Add dependencies:
   ```bash
   npm i @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/client-s3
   npm i -D aws-cdk esbuild aws-sdk-client-mock @aws-appsync/utils @types/aws-lambda
   ```
3. Add scripts to `package.json`:
   ```json
   "typecheck": "tsc -p .",
   "synth": "cdk synth",
   "deploy": "cdk deploy --require-approval never --outputs-file cdk-outputs.json",
   "destroy": "cdk destroy",
   "reset-data": "tsx scripts/reset-data.ts",
   "test:ddb": "vitest run test/dynamoStore.local.test.ts"
   ```
4. Add `cdk.json`: `{ "app": "npx tsx bin/pv4.ts" }`.

**Gate:** `npm test && npm run typecheck` → green (same counts as before).

---

### Phase 2 — Store port and fake store (30 min)

The processor must not know about DynamoDB. It talks to a `Store` interface, so it can be
tested exhaustively in memory, including failure cases that are hard to reproduce on AWS.

**`src/store.ts`** — define:

```ts
export type Outcome = 'ACCEPTED' | 'IGNORED' | 'REJECTED';
export interface StoredAthlete { revision: number; status: string; lane: number; timeMs: number }

export type TxResult =
  | { kind: 'COMMITTED' }
  | { kind: 'ALREADY_PROCESSED'; outcome: Outcome }   // delivery marker already existed
  | { kind: 'RETRY'; reason: 'CONDITION_FAILED' | 'CONFLICT' | 'TRANSIENT' };

export interface Store {
  getAthlete(eventId: string, bib: string): Promise<StoredAthlete | undefined>;
  createAthlete(u: TimingUpdate, requestId: string): Promise<TxResult>;
  advanceAthlete(u: TimingUpdate, requestId: string): Promise<TxResult>;
  recordIgnored(u: TimingUpdate, requestId: string): Promise<TxResult>;
  recordRejected(requestId: string): Promise<TxResult>;
}
```

**`src/fakeStore.ts`** — in-memory implementation with the same semantics as §3.2, plus
fault injection:

```ts
fake.injectNext('CONFLICT')        // next tx returns RETRY/CONFLICT, writes nothing
fake.injectNext('LOST_RESPONSE')   // next tx COMMITS, then throws a network error
fake.injectNext('TRANSIENT')       // next tx writes nothing, throws a retryable error
fake.snapshot()                    // { events, results(eventId), eventStats(eventId), updatesRejected }
```

**Tests first (`test/fakeStore.test.ts`):**
- create on a new athlete commits; create on an existing one → `RETRY/CONDITION_FAILED`.
- advance with a revision ≤ stored → `RETRY/CONDITION_FAILED`, nothing written.
- the same `requestId` used twice → second call `ALREADY_PROCESSED` with the first outcome.
- `LOST_RESPONSE` really commits (snapshot shows it) and then throws.
- a failed transaction writes nothing at all (all-or-nothing).

**Gate:** `npm test` green.

---

### Phase 3 — Processor core (60 min) — *most important phase*

**`src/processor.ts`** exports:

```ts
processUpdate(
  input: { body?: string | null; isBase64Encoded?: boolean; requestId: string },
  deps: { store: Store; deadLetter: DeadLetter; log: Logger; sleep?: (ms: number) => Promise<void>; now?: () => Date }
): Promise<{ statusCode: number; body: string }>
```

It implements §3.2 exactly, reusing `parseBody`, `validateUpdate` and `decide`. It logs one
`log.outcome(...)` line per update with trace context
`{ requestId, eventId, bib, revision, status }` (best effort for corrupt payloads: include
whichever of those fields are present). It also adds `storedRevision` and
`reason: 'STALE' | 'DUPLICATE_OR_SAME_REVISION'` for IGNORED, `previousRevision` for
ACCEPTED, and `errors` + `deadLetterKey` for REJECTED. It emits the metric
`TransactionConflictRetries` when attempts > 1, and `ProcessingFailures` on FAILED.
Per D22 it also emits `ResultsReopened` when an ACCEPTED update's status ranks below the
stored status (PROVISIONAL < CONFIRMED < OFFICIAL), and `ConflictingRevision` when an
IGNORED update has the same revision as stored but a different status, timeMs or lane
(log it at WARN with both versions). Tests for both go in `processor.test.ts`.
`sleep` is injected so tests do not actually wait.

**Tests first (`test/processor.test.ts`), using `FakeStore`:**

*The worked example (must match the brief exactly)*
- Six updates for AUS-1147 in the brief's order → outcomes
  `ACCEPTED, ACCEPTED, IGNORED, IGNORED, IGNORED, ACCEPTED`. Final state `PROVISIONAL`
  rev 4. Stats: accepted 3, ignored 3, athletesTracked 1. `updatesRejected` 0.

*HTTP contract*
- ACCEPTED → 200, body `{ outcome: "ACCEPTED", requestId }`.
- IGNORED → 200.
- invalid field → 400 with `errors` listing every bad field.
- unparseable body, empty body, `null` body, base64 garbage → 400, counted in `updatesRejected`.
- all responses have `content-type: application/json`.

*Validation*
- every corruption in `scenario.ts`'s `CORRUPTIONS` → 400, `updatesRejected` +1, no athlete,
  no event in `events`, stats of other events unchanged.
- a corrupt update does not block the next valid one.
- the dead-letter writer receives `{ raw, errors, requestId, receivedAt }`, and the key is
  logged as `deadLetterKey`.
- the dead-letter writer throwing → still 400, still counted, ERROR logged.

*Ordering*
- lower revision after higher → IGNORED, state unchanged, `reason: "STALE"`.
- equal revision with a different status → IGNORED, `reason: "DUPLICATE_OR_SAME_REVISION"`.
- OFFICIAL → PROVISIONAL with a higher revision → ACCEPTED (the jury case).
- the same bib in two events → independent.
- the first revision seen can be any value ≥ 1.

*Retries and idempotency (fault injection)*
- `CONFLICT` once, then success → ACCEPTED once, counted once, `TransactionConflictRetries`
  metric emitted.
- `LOST_RESPONSE` on an ACCEPTED transaction → the retry returns ALREADY_PROCESSED, and the
  response is still 200 ACCEPTED. **Counters show exactly 1 accepted, 0 ignored.**
  *(This is the double-count trap; the test is mandatory.)*
- `LOST_RESPONSE` on a REJECTED transaction → counted once.
- a race: between `getAthlete` and create, another request creates the athlete (simulate via
  a hook in FakeStore) → create fails the condition → re-read → advance or ignore correctly.
- 8 consecutive `CONFLICT`s → 503, `ProcessingFailures` metric emitted, ERROR log, nothing counted.
- `TRANSIENT` → retried.

*Logging*
- every processed update emits exactly one line with `outcome` set.
- the lines for one bib all carry `eventId`, `bib` and `requestId` (trace test).

**Gate:** `npm test` green. Coverage of `src/processor.ts` ≥ 95% lines
(`npx vitest run --coverage` with `@vitest/coverage-v8`).

---

### Phase 4 — Differential testing against the oracle (30 min)

**`test/processor.differential.test.ts`:** for 300 seeds of
`makeScenario({ athletesPerEvent: 8, maxRevision: 6, dupRate: 0.3, corruptRate: 0.1, eventIds: ['E1','E2'] })`:

1. Feed the scenario through `processUpdate` + `FakeStore`, **sequentially**.
2. Feed the same scenario through `ReferenceStore`.
3. Assert, for every event, that `results` (sorted by bib), `eventStats` and `events` are
   deep-equal, and that `updatesRejected` is equal.
4. Assert `Σaccepted + Σignored + rejected === feed.length`.

Then repeat with **random fault injection**: roughly 20% of transactions get `CONFLICT`,
`LOST_RESPONSE` or `TRANSIENT`. The final state and **all counters must still equal the
oracle exactly**. This single test proves idempotency and retry correctness together.

Finally, a **concurrency** variant: run the feed through `processUpdate` with
`Promise.all` over batches of 10. Assert the final `results` equal the oracle, and
`accepted + ignored` per event equals the oracle's total. (Under concurrency the split
between the two depends on arrival order, which is correct behaviour.)

**Gate:** `npm test` green.

---

### Phase 5 — DynamoDB store (45 min)

**`src/dynamoStore.ts`** implements `Store` using `@aws-sdk/lib-dynamodb`
(`DynamoDBDocumentClient`) with:

- `GetCommand` with `ConsistentRead: true` for `getAthlete`.
- `TransactWriteCommand` for the four transactions in §3.2, using
  `ExpressionAttributeNames` for `#revision` and `#status` (`status` is a DynamoDB reserved
  word).
- Delivery marker `ttl` = now + 86 400 seconds.
- On `TransactionCanceledException`, map `CancellationReasons` **by item index**:
  - delivery item index `ConditionalCheckFailed` → `GetCommand` the marker (consistent) →
    `ALREADY_PROCESSED` with its stored `outcome`.
  - any other `ConditionalCheckFailed` → `RETRY/CONDITION_FAILED`.
  - any `TransactionConflict` → `RETRY/CONFLICT`.
- `ProvisionedThroughputExceeded`, `ThrottlingException`, `InternalServerError`,
  `RequestLimitExceeded`, and network errors → `RETRY/TRANSIENT`.
- Anything else → throw.
- Create the client once, outside the handler, so it is reused across warm invocations.

**Tests first:**
- `test/dynamoStore.test.ts` (with `aws-sdk-client-mock`): assert the exact command inputs,
  i.e. keys, condition expressions, `ADD` updates, `ConsistentRead: true`, and delivery
  marker position. Assert each cancellation-reason mapping above.
- `test/dynamoStore.local.test.ts` (skipped unless `DDB_ENDPOINT` is set): start DynamoDB
  Local (`docker run -p 8000:8000 amazon/dynamodb-local`), create the table in `beforeAll`,
  and **run the Phase 4 differential test against `DynamoStore` instead of `FakeStore`**,
  sequential and concurrent.

**Gate:** `npm test` green. If Docker is available:
`DDB_ENDPOINT=http://localhost:8000 npm run test:ddb` green.

---

### Phase 6 — Lambda handler and ingest infrastructure (30 min)

**`src/handler.ts`:**
- API Gateway HTTP API payload v2 (`APIGatewayProxyEventV2`).
- `requestId = event.requestContext.requestId`.
- Calls `processUpdate` with a `DynamoStore`, an `S3DeadLetter` and the logger
  `createLogger({ service: 'pv4-ingest' })`.
- **Never lets an exception escape** for bad input. Only genuine infrastructure failure
  results in a 503, which is logged and metered.

**`src/deadLetter.ts`:** `S3DeadLetter.put(record)` →
key `rejected/{yyyy-mm-dd}/{requestId}.json`, `ContentType: application/json`, and returns
the key. Also an `InMemoryDeadLetter` for tests.

**`infra/data.ts`:** table `pv4` (`pk`/`sk` strings, `PAY_PER_REQUEST`,
`timeToLiveAttribute: 'ttl'`, `RemovalPolicy.DESTROY`). Dead-letter bucket: private,
SSL enforced, 30-day lifecycle expiry, `DESTROY` + `autoDeleteObjects`.

**`infra/ingest.ts`:** `NodejsFunction` (Node 22, ARM64, 512 MB, 10 s timeout, esbuild
bundling), with its own `LogGroup` (1-month retention, `DESTROY`).
Env: `TABLE_NAME`, `DEAD_LETTER_BUCKET`. Grants: `table.grantReadWriteData`,
`bucket.grantPut`. `HttpApi` with route `POST /timing` → Lambda integration.
Output `IngestUrl = ${apiEndpoint}/timing`.

**Tests first:**
- `test/handler.test.ts`: v2 event fixtures (plain JSON, base64, missing body) →
  correct status codes; `requestId` is taken from the request context.
- `test/stack.test.ts` (CDK assertions):
  - table: billing mode, key schema, TTL attribute.
  - the Lambda has both env vars and the right runtime/architecture.
  - the IAM policy includes `dynamodb:TransactWriteItems` and `s3:PutObject` on the right resources.
  - the route key is exactly `POST /timing`.
  - the bucket lifecycle is 30 days and public access is blocked.
  - every resource with data has `DeletionPolicy: Delete`.
  - outputs `IngestUrl`, `GraphqlUrl`, `GraphqlApiKey`, `ResultsPageUrl`, `DashboardUrl` exist.

**Gate:** `npm test && npm run typecheck && npx cdk synth` all succeed.

---

### Phase 7 — AppSync resolvers, stack composition, observability addition (40 min)

**`resolvers/*.js`** — plain JavaScript for the `APPSYNC_JS` runtime. Runtime restrictions
the agent must respect:
- no `try/catch`, no `throw` (use `util.error`), no `while` or `for(;;)` loops (use array
  methods), no classes, no `async`.
- avoid `?.` and `??`; use `x || default` for safety.

Example (`resolvers/results.js`):

```js
import { util } from '@aws-appsync/utils';

export function request(ctx) {
  return {
    operation: 'Query',
    query: {
      expression: 'pk = :pk AND begins_with(sk, :prefix)',
      expressionValues: util.dynamodb.toMapValues({ ':pk': 'EVENT#' + ctx.args.eventId, ':prefix': 'BIB#' }),
    },
    consistentRead: true,
    limit: 1000,
  };
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type);
  return ctx.result.items.map((i) => ({ bib: i.bib, lane: i.lane, revision: i.revision, status: i.status, timeMs: i.timeMs }));
}
```

`eventStats.js` response: `const i = ctx.result || {};` then return
`{ eventId: ctx.args.eventId, athletesTracked: i.athletesTracked || 0, updatesAccepted: i.updatesAccepted || 0, updatesIgnored: i.updatesIgnored || 0 }`.

`updatesRejected.js` response: `(ctx.result && ctx.result.updatesRejected) || 0`.

**`infra/resolvers.ts`:** `api.addDynamoDbDataSource('Table', table)` (read-only grant is
enough), plus four resolvers with `runtime: appsync.FunctionRuntime.JS_1_0_0` and
`code: appsync.Code.fromAsset('resolvers/<name>.js')`.

**`infra/pv4-stack.ts` + `bin/pv4.ts`:** compose data → ingest → api → resolvers → site →
observability (`alarmEmail` from context).

**`infra/observability.ts` addition (test first):** a third alarm `pv4-processing-failures`
on the custom metric `ProcessingFailures` ≥ 1 in 1 minute. The processor returns a 503
instead of throwing, so Lambda's `Errors` metric would not see those failures.
Also a fourth alarm `pv4-conflicting-revision` on `ConflictingRevision` ≥ 1 in 1 minute
(D22). Four alarms in total is still inside the free tier of 10.

**Tests first:**
- `test/resolvers.test.ts`: `vi.mock('@aws-appsync/utils')` with a minimal `util`
  (`toMapValues` = identity-ish map, `error` throws). For each resolver, assert the request
  has the correct operation, key and `consistentRead: true`; the response maps correctly;
  empty and `null` results give `[]`, zeros or `0`; `ctx.error` → `util.error` is called.
- `test/stack.test.ts`: 4 resolvers, all `APPSYNC_JS`, attached to `Query.events`,
  `Query.results`, `Query.eventStats` and `Query.updatesRejected`.
- `test/infra.test.ts`: the new alarm exists and uses the namespace from `src/obs.ts`.

**Gate:** `npm test && npm run typecheck && npx cdk synth` green.

---

### Phase 8 — Deploy and run the harness (40 min)

**Do**
0. Before the first deploy (D19, D21):
   - Create an AWS Budget: Billing → Budgets → $5/month cost budget, email alert at 80%.
   - Service Quotas → AWS Lambda → "Concurrent executions" for ap-southeast-2. If it is
     below 100, request an increase to 1000 (it is free and usually approved quickly).
   - The HTTP API default stage must have throttling set to rate 200 / burst 400. Verified
     working with aws-cdk-lib 2.271:
     ```ts
     const httpApi = new apigwv2.HttpApi(this, 'IngestApi');
     const stage = httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
     stage.defaultRouteSettings = { throttlingRateLimit: 200, throttlingBurstLimit: 400 };
     ```
     Add a CDK assertion test that `AWS::ApiGatewayV2::Stage` has
     `DefaultRouteSettings: { ThrottlingRateLimit: 200, ThrottlingBurstLimit: 400 }`.
   - Check the Lambda quota from the CLI:
     `aws lambda get-account-settings --region ap-southeast-2 --query AccountLimit.ConcurrentExecutions`.
     If it is below 100:
     `aws service-quotas request-service-quota-increase --region ap-southeast-2 --service-code lambda --quota-code L-B99A9384 --desired-value 1000`.
1. `npx cdk bootstrap aws://<account>/ap-southeast-2` (once per account).
2. `npm run deploy -- -c alarmEmail=<you>` and confirm the SNS email.
3. Read `cdk-outputs.json` and export the three variables:
   ```bash
   export INGEST_URL=... GRAPHQL_URL=... API_KEY=...
   ```
4. `scripts/smoke.sh`: POST the brief's example, then query all four fields, printing the results.
5. `npm run test:e2e`. This covers: the worked example read immediately with no sleep, a
   randomised feed with corruption vs the oracle, edge-rejected bodies, phantom events, and
   a concurrent burst.
6. **Extend the e2e harness (test first, then run):**
   - an alternating-status feed (OFFICIAL/PROVISIONAL at random revisions): the final state
     equals the max revision.
   - 50 updates for 10 bibs in parallel, run **3 times**: results always equal the oracle's
     final state, and `accepted + ignored` equals the number sent.
   - `content-type: text/plain` and a missing content type → still processed.
   - numeric strings, floats, a 2³¹ value → rejected (400), and `updatesRejected` rises by exactly that many.
   - the same body POSTed twice (two requests) → counted twice: 1 accepted, 1 ignored.
7. Open the CloudFront URL, pick the event, and click Refresh while running `dev/demo.ts`
   against `INGEST_URL`.
8. Take the screenshots listed in `docs/SECTIONS-4-5.md` (page, dashboard, trace a bib,
   alarm in ALARM after the corrupt-update burst, then back to OK).
9. **`npm run reset-data`** so all counters are 0. Run `scripts/smoke.sh` once more, then
   reset again.

**`scripts/reset-data.ts`:** scan the table and batch-delete every item (the table is
small). Print the number of items deleted. Prompt for `y/N` before deleting.

**Gate:** `npm run test:e2e` → **all passed, run 3 times in a row.** After reset,
`updatesRejected` is 0 and `events` is `[]`.

---

### Phase 9 — Documentation (40 min — do not skip; it is scored)

**`README.md`:** what it is, "deployed URLs and API key: see the submission email" (D20 —
never put them in the public repo), a one-paragraph architecture
summary with the §3 diagram, how to deploy/test/destroy, the local dev loop
(`npm run dev`), and the screenshots.

**`DECISIONS.md`** — exactly three sections, as the brief asks:

1. **Known concessions** — be honest. At least:
   - Non-POST methods and other paths aren't counted (D16).
   - Bodies over 10 MB are rejected by API Gateway before Lambda and are not counted (D16).
   - `results` and `events` read at most 1000 items / 1 MB per query (no pagination). Fine for a race, not for a whole championship.
   - Under concurrent delivery the accepted/ignored split depends on arrival order; totals and final state do not.
   - Dead-letter storage is best effort after counting. If S3 fails, the update is still counted and logged, but its payload is only in the logs (truncated).
   - The rejected-payload bucket is not reachable without account access; describe where it is.
   - **Equal revisions: the first to arrive wins.** If a wrong revision N arrives before the
     genuine revision N, the genuine one is ignored (it is not greater), per the brief's
     rule. It stays wrong until revision N+1 arrives. We cannot tell which one is "right"
     (`recordedAt` is untrustworthy), so we detect it (`ConflictingRevision` metric + WARN
     log with both versions) rather than guess.
   - **A bogus very high revision** (e.g. 999 from a faulty rig) would make every later
     genuine revision look stale. Valid by the rules, so it is accepted; in production an
     operator override would be needed.
   - Anything the human knowingly skipped.
2. **How it works, and why** — the three rules:
   - Idempotency: the delivery marker plus the monotonic revision condition.
   - Ordering: the conditional write inside a transaction; status is never consulted.
   - Validation: `validate.ts`, the dead-letter bucket and the counter.

   Also cover why synchronous processing and consistent reads, why transactions, and the
   alternatives considered: SQS + consumer (rejected, D1), read-compare-write (rejected,
   race condition), Lambda resolvers (rejected, JS resolvers are simpler and faster).
   State confidence levels and the evidence: the differential tests, fault injection, the
   e2e harness 3×. List all of D1–D18 briefly.
3. **AI assistance** — honest. Name the tools (e.g. Claude for analysing the brief, test
   design and the plan; Cursor for implementation), which parts each touched, why, and
   what you verified yourself.

**Gate:** a human reads both files top to bottom.

---

### Phase 10 — NOT PLANNED (reference only): live updates with AppSync subscriptions

Decision D15 chose polling. Do not build this unless the human explicitly asks. It is kept
here so DECISIONS.md can describe the production upgrade accurately.

- Schema additions (the contract stays untouched):
  ```graphql
  type EventChanged @aws_api_key @aws_iam { eventId: ID! }
  type Mutation { notifyEventChanged(eventId: ID!): EventChanged! @aws_iam }
  type Subscription {
    onEventChanged(eventId: ID!): EventChanged
      @aws_subscribe(mutations: ["notifyEventChanged"]) @aws_api_key
  }
  ```
- Add IAM as an additional authorisation mode. `notifyEventChanged` uses a `NONE` data
  source (it just passes the arguments through).
- Enable DynamoDB Streams (`NEW_IMAGE`). A small Lambda collects the distinct `eventId`s
  from changed `EVENT#` items in each batch and calls `notifyEventChanged` once per event,
  signing with IAM.
- Page: open the AppSync real-time WebSocket, subscribe to `onEventChanged` for the selected
  event, and on each message **refetch** via the normal query (debounced 200 ms). Push a
  signal, not data: messages can be duplicated or reordered too. Keep the Refresh button.
  Fall back to polling every 30 s while disconnected.
- Tests: stream-handler unit tests (dedupes eventIds per batch; ignores `GLOBAL` and
  `DELIVERY` items); a CDK assertion that the mutation is IAM-only.
- On every (re)connect, refetch immediately: messages sent while disconnected are lost,
  and the refetch resyncs the page.
- Remove the 5 s auto-refresh checkbox from `web/index.html` (D15).
- Mention it in DECISIONS.md as an addition beyond scope.

---

## 6. Final submission checklist

- [ ] `npm test` green, `npm run typecheck` clean, `npx cdk synth` clean.
- [ ] `npm run test:e2e` green **three times in a row** against the deployed stack.
- [ ] The concurrent burst e2e test passes every time.
- [ ] The API key expiry in the AppSync console is about 360 days away.
- [ ] The CloudFront page loads in a private window, lists events, and Refresh works.
- [ ] **Data reset**: `events` is `[]` and `updatesRejected` is `0`.
- [ ] No test data was ever sent with the eventId `WC26-ATH-M100M-SF2` (they might send it).
      If it was, the reset covers it.
- [ ] Repo is **public**, and `DECISIONS.md` is in the root.
- [ ] Every commit is authored by you: `git log --format='%an <%ae>' | sort -u` shows only
      your name, and `git log | grep -i "co-authored"` finds nothing.
- [ ] README has the screenshots, and **no URLs or API key** (D20): `git grep -n "execute-api\|appsync-api\|cloudfront.net\|da2-"` finds nothing.
- [ ] No AWS access keys anywhere in git history: `git log -p | grep -n "AKIA"` finds nothing.
- [ ] Submission email: repo link, ingest URL, AppSync URL + API key, CloudFront URL, and honest time spent.
- [ ] Stack left deployed. After they reply, `npm run destroy` removes everything.

## 7. Harness scorecard — what each check maps to

| Likely harness check | Guaranteed by | Proven by |
|---|---|---|
| Worked example: 3 accepted / 3 ignored, PROVISIONAL rev 4 | §3.2, `decide.ts` | processor.test, e2e |
| Duplicates never inflate counts | delivery marker + revision condition | fault-injection differential |
| Stale revisions never overwrite | `#revision < :rev` condition | processor.test, e2e |
| Reopen (status backwards, higher revision) is applied | status never consulted | model.test, processor.test |
| Every update counted exactly once | same-transaction counters, ALREADY_PROCESSED | differential Σ check, e2e |
| Corrupt → rejected, no crash, no phantom | `validate.ts`, reject path | processor.test, e2e phantom test |
| Edge 4xx counted too | single reject path | e2e edge bodies |
| Read immediately after write | sync processing + consistent reads | e2e no-sleep test |
| Parallel sends | conditional transactions + conflict retry | concurrent differential, e2e burst ×3 |
| Unknown event → zeros / `[]` | resolver defaults | resolvers.test, e2e |
| Page discovers events, shows results + stats, refetches | `web/index.html` | manual check + screenshots |
| Logs trace a bib, custom metric, alarm in CDK | `obs.ts`, `observability.ts` | obs.test, infra.test, screenshots |

## 8. Interview preparation — the human must be able to explain

- Why `revision` and not `status`, `lane` or `recordedAt` orders updates.
- Walk through the worked example against the code, line by line.
- The four transactions in §3.2: what each condition protects against.
- The "committed but response lost" scenario, and how the delivery marker prevents a double count.
- Why a read-then-write in Lambda alone would be wrong under concurrency.
- Why synchronous processing, and what you would change at 100× the load (queue + ordered
  consumer per `eventId`, and then the read-after-write trade-off).
- Why the alarm is on the rejection *rate*, and why `bib` is not a metric dimension.
- Why bib values are inserted with `textContent` on the page.
- Why the API key expiry is 360 days.
- What an AppSync JS resolver is, and why every read is `consistentRead: true`.
- Everything listed in DECISIONS.md → concessions.
