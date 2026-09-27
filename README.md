# PV4 timing ingest

A small pipeline that takes live timing updates, keeps the latest revision of each athlete, and serves the result to a results page.

Deployed URLs and the AppSync API key are in the submission email. They are not in this repo.

## Architecture

```
Timing feed ─POST /timing─▶ API Gateway HTTP API ─▶ Lambda processor
                                                      │ parse → validate → decide
                                                      │ TransactWriteItems (state + counters + delivery marker)
                                                      ├──────────────▶ DynamoDB table pv4
                                                      ├── rejected ─▶ S3 dead-letter bucket
                                                      └── JSON logs + EMF metrics ─▶ CloudWatch

Harness / page ─GraphQL (x-api-key)─▶ AppSync JS resolvers (consistent reads) ─▶ DynamoDB
Browser ─HTTPS─▶ CloudFront ─▶ S3 (index.html + config.json)
```

The processor runs inside the ingest request. The HTTP response is sent only after the write commits, and every read uses a consistent read, so a query immediately after a POST sees that update. Ordering is by `revision` per athlete. Status is stored, never used to decide which update wins.

## Deploy, test, destroy

Region is `ap-southeast-2`.

```bash
npm install
npx cdk bootstrap aws://<account>/ap-southeast-2
npm run deploy -- -c alarmEmail=<you>
```

Confirm the SNS subscription email. Then, from `cdk-outputs.json` (gitignored):

```bash
export INGEST_URL=... GRAPHQL_URL=... API_KEY=...
bash scripts/smoke.sh
npm run test:e2e
```

Run the harness three times. Before you send the submission, wipe the table so the pipeline-wide rejection counter is back to zero:

```bash
npm run reset-data
```

Tear the stack down after the review:

```bash
npm run destroy
```

## Local checks

```bash
npm test          # unit tests; the deployed harness is skipped without env vars
npm run typecheck
npx cdk synth
npm run dev       # fake ingest + GraphQL + page on http://localhost:4000
```

`npm run test:ddb` runs the same differential checks against DynamoDB Local when `DDB_ENDPOINT` is set.

## Results page

`screenshots/` shows the page: a race, the same page after refresh, dark mode, and a narrow viewport. The event list comes from the `events` query. Refresh fetches again without reloading. Auto every 5s does the same while the tab is visible.
