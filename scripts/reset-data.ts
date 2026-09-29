/**
 * Wipe the pv4 table before handover so updatesRejected is 0 and events is [].
 * Usage: npm run reset-data
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const tableName = process.env.TABLE_NAME ?? 'pv4';
const region = process.env.AWS_REGION ?? 'ap-southeast-2';
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

const rl = createInterface({ input: stdin, output: stdout });
const answer = await rl.question(`Delete every item in ${tableName} (${region})? [y/N] `);
rl.close();
if (answer.trim().toLowerCase() !== 'y') {
  console.log('aborted');
  process.exit(0);
}

let deleted = 0;
let startKey: Record<string, unknown> | undefined;
do {
  const page = await doc.send(new ScanCommand({
    TableName: tableName,
    ExclusiveStartKey: startKey,
    ProjectionExpression: 'pk, sk',
  }));
  const items = page.Items ?? [];
  for (let i = 0; i < items.length; i += 25) {
    let pending: { DeleteRequest: { Key: Record<string, unknown> } }[] = items.slice(i, i + 25).map((item) => ({
      DeleteRequest: { Key: { pk: item.pk, sk: item.sk } },
    }));
    deleted += pending.length;
    // Unprocessed keys are retried; the table is small enough that this finishes quickly.
    for (let attempt = 0; pending.length > 0 && attempt < 5; attempt++) {
      const res = await doc.send(new BatchWriteCommand({
        RequestItems: { [tableName]: pending },
      }));
      pending = (res.UnprocessedItems?.[tableName] ?? []) as typeof pending;
    }
    if (pending.length > 0) throw new Error(`failed to delete ${pending.length} items`);
  }
  startKey = page.LastEvaluatedKey;
} while (startKey);

console.log(`deleted ${deleted} items`);
