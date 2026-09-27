# Technical assessment — Software Developer, PV4 Product Development

**RWS Global**

Thanks for making it to this stage. This exercise is deliberately small in surface area and deliberately awkward in the middle. We are not trying to find out whether you can wire up AWS services — we assume you can. We are trying to see how you handle a feed that misbehaves, because that is most of what PV4 actually does.

---

## Timebox — please read this first

**Spend no more than 6 hours. Four is fine. We would rather see a well-reasoned partial submission than a complete one that cost you a weekend.**

Leave time for the write-up in section 6. It is read as carefully as the code.

If anything below is ambiguous, make a decision, write down why, and move on. Some of it is under-specified on purpose.

---

## The scenario

PV4 ingests live scoring and timing data from venue systems during competition. For a track event, the timing system emits an update for each athlete every time their result changes state as the race is processed and adjudicated:

```
        ┌──────────────────────────────────────────┐
        │                                          │
        ▼                                          │
  PROVISIONAL  ──▶  CONFIRMED  ──▶  OFFICIAL  ─────┘
  raw time off      checked by      ratified;    protest upheld —
  the beam          the referee     protest      result reopened
                                    window closed
```

**Results usually move left to right, but not always.** A jury of appeal can uphold a protest after a result has been declared official. The result is then un-ratified and goes back to provisional while it is re-reviewed, before working forward again. Status is not one-way.

Downstream of you sit venue scoreboards, the broadcast graphics feed and the public results site. So the failure that matters is not an outage — it is a result changing when it **shouldn't**, or failing to change when it **should**. A time ratified as OFFICIAL must not flip back to PROVISIONAL because a forty-second-late copy of an old update turned up. But if the jury genuinely reopens that result, the scoreboard must show it immediately. Both of those happen in front of a stadium and a broadcast audience, and telling them apart is the entire problem.

Timing feeds misbehave in three specific ways. Treat all three as permanent facts of life rather than bugs to be fixed upstream — you cannot ask a stadium timing rig to be better behaved mid-competition:

1. **They deliver at-least-once.** The same update will sometimes arrive more than once.
2. **They deliver out of order.** A later revision of a result can arrive before an earlier one.
3. **They occasionally emit corrupt payloads.** Roughly one update in ten is unusable.

Your job is to build something that stays correct anyway.

> **A note on the word "event".** In sport, an *event* is the competition itself — the men's 100 m semi-final. Throughout this brief the messages arriving from the timing system are called **updates**, never events, to keep the two apart. `eventId` always means the race.

---

## What to build

A small ingest-and-read pipeline, defined entirely in **AWS CDK (TypeScript)**, deployed to your own AWS account. The task is solvable end to end with serverless services, and should not cost you anything to build or run.

```
  POST /timing  ──▶   your design   ──▶  AppSync (GraphQL)  ──▶  CloudFront + S3 page
   timing updates                          results + stats            results page
        in                                                                out
```

The two ends are fixed because we need to drive them: an HTTP endpoint we can post to, and an AppSync API we can query against a known contract. What happens between them is yours to decide.

### 1. An ingest endpoint

An HTTPS endpoint accepting `POST` with a JSON body.

A well-formed timing update looks exactly like this:

```json
{
  "eventId":    "WC26-ATH-M100M-SF2",
  "bib":        "AUS-1147",
  "lane":       3,
  "revision":   2,
  "status":     "CONFIRMED",
  "timeMs":     10105,
  "recordedAt": "2026-08-25T19:42:07.000Z"
}
```

| Field | Type | Rule |
|---|---|---|
| `eventId` | string | Required, non-empty. The race. |
| `bib` | string | Required, non-empty. Identifies the athlete within the event. |
| `lane` | integer | Required. The athlete's lane. Fixed for the race — **not** an ordering signal. |
| `revision` | integer ≥ 1 | Required. Increases monotonically **per `bib`**. This is the only reliable ordering signal. |
| `status` | string | Required. Exactly one of `"PROVISIONAL"`, `"CONFIRMED"` or `"OFFICIAL"` — three separate values, nothing else accepted. |
| `timeMs` | integer > 0 | Required. Elapsed time in milliseconds. |
| `recordedAt` | ISO 8601 string | Present, but **do not validate or order on it.** It comes from timing hardware whose clock is not trustworthy. |

An update is corrupt, and must be rejected, if any of `eventId`, `bib`, `lane`, `revision`, `status` or `timeMs` fails the rule above. `recordedAt` is not validated.

The `eventId` above is illustrative. We will not tell you in advance which event we send, and it may not be that one.

`lane` is where the athlete is standing. It never changes and it tells you nothing about which update is newer — `revision` does that, and only within a single `bib`. Two athletes' revision numbers are unrelated to each other.

**`revision` is the only ordering signal.** A higher revision is newer information, whatever status it carries. `status` is data to be stored, not a signal to order by.

**A worked example.** Six updates arrive for `AUS-1147`, in this order:

| Arrives | `revision` | `status` | Correct outcome |
|---|---|---|---|
| 1st | 1 | `PROVISIONAL` | **Applied** — new athlete. Counts as accepted. |
| 2nd | 3 | `OFFICIAL` | **Applied** — 3 > 1. Counts as accepted. |
| 3rd | 2 | `CONFIRMED` | **Ignored** — 2 is not greater than 3. Stays `OFFICIAL`. |
| 4th | 3 | `OFFICIAL` | **Ignored** — duplicate, already at revision 3. |
| 5th | 3 | `CONFIRMED` | **Ignored** — 3 is not greater than 3, whatever status it carries. |
| 6th | 4 | `PROVISIONAL` | **Applied** — 4 > 3. The jury upheld a protest and reopened the result. Counts as accepted, even though the status moved backwards. |

Final state: `AUS-1147` at `PROVISIONAL`, revision 4. Three accepted, three ignored.

### 2. A processor that obeys three rules

This is the part that matters.

- **Idempotency.** The same update delivered twice must apply once. A duplicate must not corrupt state or inflate any count.
- **Ordering.** For a given `bib`, an update whose `revision` is not greater than the revision already stored must be discarded. An update whose `revision` is greater must be applied. `status` has no bearing on either decision.
- **Validation.** A corrupt payload must not crash the processor, must not stop the updates behind it from being applied, and must not create a phantom athlete who was never in the race. It must also not vanish silently — we should be able to tell that it happened, and get at the payload afterwards.

Everything the processor does — applied, ignored, rejected — needs to be countable. See `eventStats` below.

### 3. A read API — exact contract

Your GraphQL schema **must** include the following, exactly as written. We run an automated harness against every submission and it needs a consistent contract. Anything you want to add alongside it is welcome.

```graphql
enum ResultStatus { PROVISIONAL CONFIRMED OFFICIAL }

type Result {
  bib:      ID!
  lane:     Int!
  revision: Int!
  status:   ResultStatus!
  timeMs:   Int!
}

type EventStats {
  eventId:         ID!
  athletesTracked: Int!   # distinct bibs with stored state
  updatesAccepted: Int!   # updates that changed stored state
  updatesIgnored:  Int!   # valid, but not applied — duplicate or stale revision
}

type Query {
  events:                   [ID!]!
  results(eventId: ID!):    [Result!]!
  eventStats(eventId: ID!): EventStats!
  updatesRejected:          Int!   # failed validation, pipeline-wide
}
```

Use AppSync with **API key authentication**, and include the API key in your submission.

Three points on the counters, because we score them exactly:

- Every update you receive must land in exactly one of `updatesAccepted`, `updatesIgnored` or `updatesRejected`.
- `updatesAccepted` and `updatesIgnored` are per event. `updatesRejected` is pipeline-wide, because a corrupt update may not tell you which event it belonged to — or anything else.
- `updatesRejected` counts **every** validation failure, wherever you catch it — at the edge with a 4xx, or after accepting it. Both are legitimate; the count must be the same either way.


### 4. A results page

A static page on S3 behind CloudFront. No build step required. It must:

- Query `events` to discover what events exist, and let us choose one. Do not hardcode an event id — we have not told you which one we will send.
- Show that event's `results` and `eventStats`.
- Give us a way to fetch again without reloading the page. Results change while a race is being adjudicated.

The page needs the AppSync API key in order to read.

### 5. Observability

- Structured JSON logs from the processor, with enough context to trace a single `bib` through it.
- At least one custom CloudWatch metric.
- At least one CloudWatch alarm, defined in CDK.

### 6. `DECISIONS.md`

Cover three things.

#### 1. Known concessions

Is your solution fully compliant with this brief? If you knowingly left something out, took a shortcut, or implemented something you believe is incomplete or wrong, list it. If there is nothing, "no known concessions" is a complete answer.

#### 2. How it works, and why

Explain how your implementation satisfies the three processor rules, why you built it that way, and how confident you are in it.

If you considered other approaches and discounted them, tell us what and why. If only one sensible approach presented itself, say that instead — we are not asking you to invent alternatives you never seriously entertained.

#### 3. AI assistance

What did you use, which parts of the solution you used it for, and why you chose to use it there.

---

## Scope

Sections 1–6 are what we are asking for, and they should fit comfortably inside the timebox.

Nothing beyond that is expected, and you lose nothing by stopping there. If you do build more and it is good, we will see it and it counts in your favour — though not as cover for required work left undone.

---

## Submitting

Reply with:

- [ ] Link to a **public** GitHub or Bitbucket repo.
- [ ] Your deployed **ingest URL**.
- [ ] Your deployed **AppSync GraphQL URL and API key**.
- [ ] Your deployed **CloudFront URL**.
- [ ] `DECISIONS.md` in the repo root.
- [ ] Roughly how long it took you. Be honest — it is not a scoring input, it helps us calibrate this exercise for the next person.

Please leave the stack deployed until you hear from us, then tear it down.

We will follow up with a 35-minute conversation in which we will pick specific parts of your code and ask you to talk us through them. Anything you cannot explain, you should not submit.

Any questions at all, ask. Asking a good clarifying question is not a mark against you.

Good luck — we are looking forward to reading it.
