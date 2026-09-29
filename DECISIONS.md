# Decisions

This is the write-up for section 6 of the brief.

## 1. Known concessions

The three processor rules are implemented. The items below are the places I knowingly stopped short or accepted a limit.

- Non-POST methods, and paths other than `/timing`, get API Gateway's default 404 and are not counted. They are not timing updates.
- Bodies over API Gateway's 10 MB limit never reach the Lambda and are not counted.
- `events` and `results` return at most 1000 items (and DynamoDB's 1 MB page). That is enough for one race, not a whole championship. There is no pagination.
- Under concurrent delivery the split between `updatesAccepted` and `updatesIgnored` depends on arrival order. The final athlete state, `athletesTracked`, and the sum of the two counters do not.
- The rejected payload is written to S3 after the rejection has been counted. If that write fails, the update is still counted and the error is logged, but the payload itself is only in the log line (truncated). The bucket is private. Objects live under `rejected/YYYY-MM-DD/<requestId>.json` for 30 days. Reading them needs access to the account.
- Equal revisions: the first to arrive wins. If a wrong revision N arrives before the genuine revision N, the genuine one is ignored, because it is not greater. It stays wrong until revision N+1. `recordedAt` is not trustworthy, so the pipeline does not guess. It emits `ConflictingRevision` and a WARN log with both versions.
- A bogus very high revision (for example 999 from a faulty rig) is accepted. Every later genuine revision then looks stale. That follows the rule. Fixing it would need an operator override, which this exercise does not include.
- If DynamoDB keeps conflicting for 8 attempts, the request returns 503 and is not counted. The caller can retry with the same body; a new request id is a new delivery. This did not show up in the differential tests.
- Live subscriptions are not built. The page polls every 5 seconds. That is the production upgrade described below, not part of this submission.
- The table is wiped before handover, so `events` is `[]` and `updatesRejected` is 0. Test traffic must not be sitting in the pipeline-wide counter when the harness starts.

## 2. How it works, and why

A `POST /timing` hits API Gateway, which invokes one Lambda and waits. The Lambda parses the body, validates it, and either rejects it or applies the ordering rule. The HTTP response is sent only after the DynamoDB transaction commits. AppSync reads that same table with `consistentRead: true` and no GSI, so a query that follows the POST sees the write. The page discovers races from `events` and asks again every 5 seconds while the tab is visible.

### Idempotency

Every transaction writes a delivery marker `DELIVERY#<requestId>` with `attribute_not_exists(pk)`. API Gateway's request id is the marker key. The marker, the athlete change (or the ignore/reject), and the counter increment are one `TransactWriteItems`. If the transaction commits and the response is lost, the retry finds the marker and returns the original outcome without adding to a counter. A duplicate that arrives as a *new* request is a different marker, so it is counted once as ignored when its revision is not greater. That is the brief's duplicate rule, not a double count of one delivery.

The marker's TTL is one day. It exists only so a retry of a lost response is not counted twice.

### Ordering

For one `(eventId, bib)`, an update is applied only when its `revision` is greater than the revision stored, or when nothing is stored yet. Status, lane, `timeMs` and `recordedAt` are not consulted. A jury reopen is a higher revision whose status happens to be `PROVISIONAL`. It is applied, and the page can show it on the next poll.

The worked example is the rule in one race. For bib `AUS-1147`: revision 1 provisional is created (accepted); revision 3 official replaces it (accepted); revision 2 confirmed is ignored because 2 is not greater than 3; the second revision 3 is ignored as a duplicate; a revision 3 that says confirmed is also ignored, because an equal revision does not win even when the status differs; revision 4 provisional is applied (accepted) even though the status moved backwards. Final state is provisional at revision 4. Three accepted, three ignored.

The read before the write only chooses which of four transactions to try. DynamoDB re-checks the condition inside the transaction, so two requests can both read "no athlete" and only one create wins. The loser fails the condition, re-reads, and advances or ignores.

1. **Create.** New bib. `attribute_not_exists(pk)` on the athlete row, add `updatesAccepted` and `athletesTracked` (tracked moves only here, so it stays equal to the number of athlete rows), register the event, write the delivery marker.
2. **Advance.** Higher revision. Condition `#revision < :rev`. Status is written and never compared. `#status` is an expression name because `status` is a reserved word. Add `updatesAccepted`. Write the marker.
3. **Ignore.** Not newer. Condition `#revision >= :rev`. The athlete row is not changed. Add `updatesIgnored`. Write the marker. If a newer revision landed after the read, this condition fails and the processor retries.
4. **Reject.** The body failed validation. Add `updatesRejected` on `GLOBAL` / `STATS`, because the body may not name a real event. Write the marker. No athlete and no event are created.

A `ConditionalCheckFailed` on the delivery item wins over every other cancellation reason: the processor reads the marker with a consistent read and returns `ALREADY_PROCESSED`. Any other condition failure is a retry (`CONDITION_FAILED`). A `TransactionConflict` (two updates touching the same stats item) is a retry (`CONFLICT`). Throttling, 5xx and network errors are a retry (`TRANSIENT`). Up to 8 attempts, then 503, and nothing is counted.

Keys are `EVENT#{eventId}` / `BIB#{bib}`. The value always comes after the prefix, so an id that contains `#` cannot collide with `STATS`, the `EVENTS` registry, or a delivery marker.

### Validation

`validate.ts` rejects a payload that fails any field rule, and it returns every bad field. `recordedAt` is not validated. Integers must fit a GraphQL `Int`. Strings are stored exactly as sent. A rejection increments the pipeline-wide counter in its own transaction, then the raw body is stored in S3. The Lambda responds 400. A bad payload does not throw, does not stop the next update, and does not create an athlete or an event. A numeric string, a float, or an integer outside the GraphQL range is a rejection, not a coercion.

### Tradeoffs, and why

Each line is a choice I made, then the reason I kept it.

- **Synchronous processing.** The Lambda finishes the write before it answers. A queue would absorb bursts, and it would make the read stale: the harness queries as soon as the POST returns. At roughly 100× this load I would put a queue in front and shard consumers by `eventId`, and I would accept that the page can be a moment behind the POST.
- **Consistent reads, no GSI.** An eventually consistent read can miss a write from milliseconds ago. A GSI cannot be read consistently, so every AppSync read is `consistentRead: true` on the base table.
- **The condition lives in DynamoDB, not in the Lambda.** A read-then-write in the function alone loses under concurrency: two requests can both read the old revision and both write. The transaction re-checks `#revision < :rev` (or `attribute_not_exists` on create). The earlier read only chooses which transaction to try.
- **State and counter in one transaction.** If the Lambda dies after updating the athlete and before updating the counter, the two disagree forever. `TransactWriteItems` commits them together or not at all.
- **Delivery marker.** API Gateway can commit the write and lose the response. The retry of that same request id finds `DELIVERY#{requestId}` and returns the original outcome. A new request id with the same body is a real duplicate and is counted once as ignored.
- **Retry up to 8 times.** Every update for one race touches that race's single stats item, so parallel sends conflict. Giving up on the first conflict would drop a valid update. After 8 failures the response is 503 and nothing is counted, so a later retry can still land exactly once.
- **Count a rejection, then store the body.** The harness scores the counter. The S3 write can fail afterwards and the count still stands. The response is 400. The payload is retrievable for 30 days.
- **Stale and duplicate updates are HTTP 200 with `IGNORED`.** They are valid messages that lost the ordering rule. They are not errors, and they must still be counted.
- **Integers must fit a GraphQL `Int`, and strings are stored exactly as sent.** An out-of-range integer could never be served back. The brief gives no trimming or case-folding rule, so `aus-1147` and `AUS-1147` are different athletes. Extra fields are ignored and never stored. `recordedAt` is never validated.
- **A re-run of a race is a new `eventId`.** Revision is strictly increasing per `(eventId, bib)`. If the timing system reset revision to 1 inside the same event id, every new update would look stale and be ignored. This exercise has no operator override to reset one event.
- **API key lasts 360 days.** AppSync's default is 7 days. A reviewer can come back later than that.
- **Metrics use the `Service` dimension only.** `eventId` and `bib` stay on the log line. Each distinct dimension value is a separately billed metric, and an alarm on hundreds of series would not be one number. The log and the EMF metric share one JSON line, in namespace `PV4/Timing`, so they cannot disagree.
- **The rejection alarm is on the rate, above 25%.** The brief says roughly one update in ten is corrupt, so a count alarm would sit in ALARM during a normal race. The alarm needs at least 20 updates in a minute and 2 of 3 periods, so a short burst of bad data does not page anyone.
- **`ConflictingRevision` alarms. `ResultsReopened` does not.** A reopen is a legal higher revision whose status moved backwards; it is broadcast-critical and it is supposed to happen. Two different payloads for the same revision mean the board may be showing the wrong body, and only a person can decide which one was genuine. The metric fires so that case is visible. It does not change the stored row.
- **The page polls every 5 seconds, on by default, with no Refresh button.** The brief asks for a way to fetch again without reloading. One timer tick is one GraphQL request, and it pauses while the tab is hidden, so a background tab does not keep spending money. A checkbox turns it off. A subscription would be faster and would add a WebSocket client, a stream Lambda and IAM auth that the harness never tests. That upgrade is described below and is not in this submission.
- **On-demand DynamoDB.** A small provisioned table would throttle the harness burst. At this volume on-demand is cents.
- **The public endpoint is throttled at 200 requests/second, burst 400.** That is far above a harness and it caps the cost of someone spamming a URL that has to be public. The account Lambda concurrency quota has to be high enough for the parallel cases; it is 1000.
- **URLs and the API key stay out of the public repo.** A public repo is scraped. Junk posted at the ingest URL would move the pipeline-wide rejection counter before the harness runs. They go in the submission email only.
- **A $5 monthly budget sends email. It does not stop the account.** AWS Budgets updates a few times a day and cannot hard-cut Lambda, DynamoDB or API Gateway at exactly $5. The alert is the signal. `npm run destroy` is the off switch.
- **AppSync JS resolvers, not a second Lambda.** Each read is one GetItem or one Query. A Lambda resolver would add latency and a second copy of the key format.

### Questions

I only wanted to ask a question when the answer would change what gets built. Two ambiguities looked like questions. Neither one did.

**Two different payloads with the same revision.** I did not ask before submitting. Row 5 of the worked example is this case: an equal revision with different data is ignored, "whatever status it carries". `timeMs` cannot break the tie either. It is the result itself (10105 means 10.105 seconds), not a clock. When two revision 4s disagree, `timeMs` is usually the field they disagree on, and a referee's correction can move a time either way, so a lower time is not "more correct". `recordedAt` comes from hardware whose clock the brief says not to trust. The only question worth asking would be whether the timing system ever sends two different bodies for one revision, or whether an equal revision is always an identical copy. Either answer leaves the build the same: first write wins, because that is what the harness tests, and `ConflictingRevision` still logs and alarms, which is harmless if it never fires. I would ask it in the interview instead: does the hardware actually emit two payloads for one revision, and if so, how do operators resolve it today?

**A race re-run under the same `eventId`.** I assumed a re-run arrives as a new event id, for the reason in the tradeoff above. If a re-run reused the id and reset `revision` to 1, the pipeline would ignore the new race. That would need a different design, and the brief says revision increases monotonically per bib, so I did not block the build on it.

### Confidence

High on the three rules in code. The processor is compared with the in-memory reference model across 300 feeds, including duplicates, reordering and corruption, then again with injected conflicts, lost responses and transient errors, then again with updates applied in parallel. The worked example (3 accepted, 3 ignored, provisional revision 4) is a unit test. Command shapes for the DynamoDB transactions are asserted with a mock. Processor line coverage is 100%. On the deployed stack, two full harness runs passed, including the concurrent burst and fifty parallel updates. A third run kept the correct final results for that race and was two counts short (48 of 50). That is the 503 concession: those two gave up after repeated conflicts and were not counted. The account concurrency quota is 1000.

The production upgrade for the page, not built here, is an AppSync subscription. A stream Lambda would call a mutation with the event id only, and the page would refetch on that signal. Push the fact that something changed, not the result itself, because those messages can be duplicated too. Keep the 5 second poll as the fallback.

## 3. AI assistance

I used Cursor's coding agent and Claude for planning, for the test-first approach, and for understanding the tradeoffs. I then used Cursor's coding agent to implement it. Each tradeoff and behaviour was discussed until I could explain it. Given my teaching background, I also used AI to build a harness and then checked this submission against it.

It implemented the store, the processor, the DynamoDB transactions, the Lambda handler, the CDK stack (table, dead-letter bucket, ingest API, AppSync JS resolvers, results site, alarms), the reset script, and the tests that were not already in the starter archive. It also changed the results page so the 5 second poll is on by default and it added the comments on the ingest path.


I used it there because the behaviour is specified tightly (the three rules, the GraphQL contract, the worked example) and the risk was drifting from that specification while wiring the transactions. The ordering rule, the validation rules, the reference model, the scenario generator and the EMF logger were already in the starter archive and were not rewritten.

I had not used CDK before. I mapped each construct onto the Terraform resource I already knew (Lambda, DynamoDB, API Gateway, AppSync, S3, CloudFront) so I could explain the stack. The submitted infrastructure is CDK, which is what the brief asks for. There is no Terraform in this repository.

The decisions in section 2 were checked against the brief. I am the author of the git history.
