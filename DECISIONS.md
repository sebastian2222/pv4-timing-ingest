# Decisions

## 1. Known concessions

- Non-POST methods, and paths other than `/timing`, get API Gateway's default 404 and are not counted. They are not timing updates.
- Bodies over API Gateway's 10 MB limit never reach the Lambda and are not counted.
- `events` and `results` return at most 1000 items (and DynamoDB's 1 MB page). That is enough for one race, not a whole championship. There is no pagination.
- Under concurrent delivery the split between `updatesAccepted` and `updatesIgnored` depends on arrival order. The final athlete state, `athletesTracked`, and the sum of the two counters do not.
- The rejected payload is written to S3 after the rejection has been counted. If that write fails, the update is still counted and the error is logged, but the payload itself is only in the log line (truncated). The bucket is private. Objects live under `rejected/YYYY-MM-DD/<requestId>.json` for 30 days. Reading them needs access to the account.
- Equal revisions: the first to arrive wins. If a wrong revision N arrives before the genuine revision N, the genuine one is ignored, because it is not greater. It stays wrong until revision N+1. `recordedAt` is not trustworthy, so the pipeline does not guess. It emits `ConflictingRevision` and a WARN log with both versions.
- A bogus very high revision (for example 999 from a faulty rig) is accepted. Every later genuine revision then looks stale. That follows the rule. Fixing it would need an operator override, which this exercise does not include.
- If DynamoDB keeps conflicting for 8 attempts, the request returns 503 and is not counted. The caller can retry with the same body; a new request id is a new delivery. This did not show up in the differential tests.
- Live subscriptions are not built. The page polls. That is the production upgrade described below, not part of this submission.

## 2. How it works, and why

### Idempotency

Every transaction writes a delivery marker `DELIVERY#<requestId>` with `attribute_not_exists`. API Gateway's request id is the marker key. If the transaction commits and the response is lost, the retry finds the marker and returns the original outcome without adding to a counter. A duplicate that arrives as a *new* request is a different marker, so it is counted once as ignored when its revision is not greater. That is the brief's duplicate rule, not a double count of one delivery.

### Ordering

For one `(eventId, bib)`, an update is applied only when its `revision` is greater than the revision stored, or when nothing is stored yet. The check is a DynamoDB condition inside the same transaction as the counter update (`#revision < :rev` on advance, `attribute_not_exists` on create, `#revision >= :rev` on ignore). Status, lane and `recordedAt` are not consulted. A jury reopen is just a higher revision whose status happens to be `PROVISIONAL`. It is applied.

The read before the write only chooses which transaction to try. Two requests can both read "no athlete". One create wins; the other fails the condition, re-reads, and advances or ignores. Conflicts on the shared stats item are retried up to 8 times with a short backoff.

### Validation

`validate.ts` rejects a payload that fails any field rule, and it returns every bad field. `recordedAt` is not validated. A rejection increments the pipeline-wide `updatesRejected` counter in its own transaction, then the raw body is stored in S3. The Lambda responds 400. A bad payload does not throw, does not stop the next update, and does not create an athlete or an event.

### Why this shape

The harness may query as soon as the POST returns, so the work is done in the request (D1) and every AppSync read is `consistentRead: true` with no GSI (D2). A read-then-write in the Lambda alone would lose updates under concurrency, so the condition lives in the transaction (D3), and the state change and the counter change are the same transaction (D4). The delivery marker (D5) closes the lost-response hole. Retries (D6) are required because every update for one event touches one stats item.

Rejected updates are counted first, then stored (D7). Stale and duplicate updates are 200 with `IGNORED` (D8). Integers must fit a GraphQL `Int`, and strings are stored exactly as sent (D9, D10). A re-run of a race is assumed to use a new `eventId`; revisions are not reset inside one event (D11). The API key lasts 360 days (D12). Metrics are dimensioned only by `Service` (D13). The rejection alarm is on the rate, above the ~10% the brief says is normal (D14). The page has a Refresh button and an optional 5 second refresh that pauses while the tab is hidden (D15). The table is on-demand (D17). The public endpoint is throttled at 200 requests/second, burst 400 (D19). URLs and the API key stay out of the public repo (D20). `ResultsReopened` and `ConflictingRevision` are extra signals; the second one alarms, because the board may be showing the wrong payload for that revision (D22).

### Alternatives

A queue in front of the processor was the other serious option. It would absorb bursts, and it would make "read your write" untrue: the harness queries immediately. Synchronous processing is the right call at this volume. At roughly 100× the load I would put a queue in front and shard consumers by `eventId`, and I would accept that the page can be a moment behind the POST.

JS resolvers are used instead of Lambda resolvers. The reads are one GetItem or one Query. A Lambda would add latency and a second place for the key format to drift.

### Confidence

High on the three rules. The processor is compared with the in-memory reference model across 300 feeds, including duplicates, reordering and corruption, then again with injected conflicts, lost responses and transient errors, then again with updates applied in parallel. The worked example (3 accepted, 3 ignored, provisional revision 4) is a unit test. Command shapes for the DynamoDB transactions are asserted with a mock. What I have not yet shown is the deployed harness; that is the step that runs against the account.

The production upgrade for the page, not built here, is an AppSync subscription. A stream Lambda would call a mutation with the event id only, and the page would refetch on that signal. Push the fact that something changed, not the result itself, because those messages can be duplicated too. Keep the Refresh button.

## 3. AI assistance

Cursor's coding agent implemented this repository from `plan.md`: the store, the processor, the DynamoDB transactions, the CDK stack, the resolvers, and the tests. The ordering rule, the validation rules and the reference model were already in the starter archive and were not rewritten. I used the agent there because the behaviour is specified tightly and the risk was drifting from that specification, not a lack of an approach. The decisions in section 2 were taken from the plan and checked against the brief; they were not re-opened.

Anything in the follow-up conversation has to be explainable from this code. The differential tests and the transaction conditions are the parts to walk through first.
