/**
 * Differential checks against DynamoDB Local.
 * Skipped unless DDB_ENDPOINT is set:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   DDB_ENDPOINT=http://localhost:8000 npm run test:ddb
 */
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { beforeAll, describe, expect, it } from 'vitest';
import { InMemoryDeadLetter } from '../src/deadLetter';
import { DynamoStore } from '../src/dynamoStore';
import { ReferenceStore, type Result } from '../src/model';
import { createLogger } from '../src/obs';
import { processUpdate } from '../src/processor';
import { makeScenario } from '../src/scenario';

const endpoint = process.env.DDB_ENDPOINT;
const tableName = 'pv4-local';

describe.skipIf(!endpoint)('DynamoStore against DynamoDB Local', () => {
  let doc: DynamoDBDocumentClient;
  let store: DynamoStore;

  beforeAll(async () => {
    const raw = new DynamoDBClient({
      endpoint,
      region: 'ap-southeast-2',
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    });
    try {
      await raw.send(new CreateTableCommand({
        TableName: tableName,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
      }));
    } catch (err) {
      if ((err as { name?: string }).name !== 'ResourceInUseException') throw err;
    }
    doc = DynamoDBDocumentClient.from(raw);
    store = new DynamoStore(doc, tableName);
  });

  it('matches the oracle sequentially', async () => {
    await runSeeds(20, 'seq', false);
  }, 180_000);

  it('matches the oracle in concurrent batches', async () => {
    await runSeeds(10, 'con', true);
  }, 180_000);

  async function runSeeds(n: number, prefix: string, concurrent: boolean) {
    const log = createLogger({ service: 'pv4-ingest' }, { sink: () => {} });
    const deadLetter = new InMemoryDeadLetter();
    const sleep = async () => {};

    for (let seed = 1; seed <= n; seed++) {
      const eventIds = [`${prefix}${seed}-E1`, `${prefix}${seed}-E2`];
      const sc = makeScenario({
        seed, athletesPerEvent: 4, maxRevision: 4, dupRate: 0.3, corruptRate: 0.1, eventIds,
      });
      const ref = new ReferenceStore();
      const rejectedBefore = await rejectedCount();
      if (concurrent) {
        for (const raw of sc.feed) ref.ingest(raw);
        for (let i = 0; i < sc.feed.length; i += 10) {
          const batch = sc.feed.slice(i, i + 10);
          const codes = await Promise.all(batch.map((raw, j) => processUpdate(
            { body: JSON.stringify(raw), requestId: `${prefix}-${seed}-${i + j}` },
            { store, deadLetter, log, sleep },
          ).then((r) => r.statusCode)));
          for (const code of codes) expect(code).toBeLessThan(500);
        }
      } else {
        for (let i = 0; i < sc.feed.length; i++) {
          ref.ingest(sc.feed[i]);
          const res = await processUpdate(
            { body: JSON.stringify(sc.feed[i]), requestId: `${prefix}-${seed}-${i}` },
            { store, deadLetter, log, sleep },
          );
          expect(res.statusCode).toBeLessThan(500);
        }
      }
      expect(await rejectedCount() - rejectedBefore).toBe(ref.updatesRejected());
      await expectMatches(ref, eventIds, concurrent);
    }
  }

  async function rejectedCount(): Promise<number> {
    const rejected = await doc.send(new GetCommand({
      TableName: tableName, Key: { pk: 'GLOBAL', sk: 'STATS' }, ConsistentRead: true,
    }));
    return (rejected.Item?.updatesRejected as number) ?? 0;
  }

  async function expectMatches(ref: ReferenceStore, eventIds: string[], concurrent: boolean) {
    for (const eventId of eventIds) {
      const page = await doc.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': `EVENT#${eventId}`, ':prefix': 'BIB#' },
        ConsistentRead: true,
      }));
      const got = (page.Items ?? []).map((i) => ({
        bib: i.bib as string, lane: i.lane as number, revision: i.revision as number,
        status: i.status as string, timeMs: i.timeMs as number,
      })).sort((a, b) => a.bib.localeCompare(b.bib));
      const want = [...ref.results(eventId)].map((r: Result) => ({
        bib: r.bib, lane: r.lane, revision: r.revision, status: r.status, timeMs: r.timeMs,
      })).sort((a, b) => a.bib.localeCompare(b.bib));
      expect(got).toEqual(want);

      const stats = await doc.send(new GetCommand({
        TableName: tableName, Key: { pk: `EVENT#${eventId}`, sk: 'STATS' }, ConsistentRead: true,
      }));
      const item = stats.Item ?? {};
      const accepted = (item.updatesAccepted as number) ?? 0;
      const ignored = (item.updatesIgnored as number) ?? 0;
      const tracked = (item.athletesTracked as number) ?? 0;
      const oracleStats = ref.eventStats(eventId);
      expect(tracked).toBe(oracleStats.athletesTracked);
      if (concurrent) {
        expect(accepted + ignored).toBe(oracleStats.updatesAccepted + oracleStats.updatesIgnored);
      } else {
        expect(accepted).toBe(oracleStats.updatesAccepted);
        expect(ignored).toBe(oracleStats.updatesIgnored);
      }
    }
  }
});
