import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoStore } from '../src/dynamoStore';
import type { TimingUpdate } from '../src/validate';

const ddbMock = mockClient(DynamoDBDocumentClient);
const NOW = new Date('2026-08-25T00:00:00.000Z');
const TTL = Math.floor(NOW.getTime() / 1000) + 86_400;

function store() {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 1 }));
  return new DynamoStore(doc, 'pv4', () => NOW);
}

const update: TimingUpdate = {
  eventId: 'E1', bib: 'AUS-1147', lane: 3, revision: 4, status: 'OFFICIAL', timeMs: 10105,
};

function itemsOf(command: TransactWriteCommand) {
  return command.input.TransactItems ?? [];
}

beforeEach(() => ddbMock.reset());
afterAll(() => ddbMock.restore());

describe('DynamoStore commands', () => {
  it('reads an athlete with a consistent get, and returns undefined when absent', async () => {
    ddbMock.on(GetCommand).resolvesOnce({
      Item: { revision: 4, status: 'OFFICIAL', lane: 3, timeMs: 10105 },
    }).resolvesOnce({});
    const s = store();
    expect(await s.getAthlete('E1', 'AUS-1147')).toEqual({ revision: 4, status: 'OFFICIAL', lane: 3, timeMs: 10105 });
    expect(await s.getAthlete('E1', 'missing')).toBeUndefined();
    const input = ddbMock.commandCalls(GetCommand)[0].args[0].input;
    expect(input).toEqual({
      TableName: 'pv4',
      Key: { pk: 'EVENT#E1', sk: 'BIB#AUS-1147' },
      ConsistentRead: true,
    });
  });

  it('creates an athlete, stats, registry and delivery marker in one transaction', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    expect(await store().createAthlete(update, 'req-1')).toEqual({ kind: 'COMMITTED' });
    const tx = itemsOf(ddbMock.commandCalls(TransactWriteCommand)[0].args[0]);
    expect(tx).toHaveLength(4);
    expect(tx[0].Put).toMatchObject({
      TableName: 'pv4',
      ConditionExpression: 'attribute_not_exists(pk)',
      Item: { pk: 'EVENT#E1', sk: 'BIB#AUS-1147', revision: 4, status: 'OFFICIAL', lane: 3, timeMs: 10105 },
    });
    expect(tx[1].Update).toMatchObject({
      Key: { pk: 'EVENT#E1', sk: 'STATS' },
      UpdateExpression: 'ADD updatesAccepted :one, athletesTracked :one SET eventId = :eventId',
      ExpressionAttributeValues: { ':one': 1, ':eventId': 'E1' },
    });
    expect(tx[2].Put?.Item).toMatchObject({ pk: 'EVENTS', sk: 'EVENT#E1', eventId: 'E1' });
    expect(tx[2].Put?.ConditionExpression).toBeUndefined();
    expect(tx[3].Put).toMatchObject({
      ConditionExpression: 'attribute_not_exists(pk)',
      Item: { pk: 'DELIVERY#req-1', sk: 'DELIVERY', outcome: 'ACCEPTED', ttl: TTL },
    });
  });

  it('advances only when the stored revision is lower', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    await store().advanceAthlete(update, 'req-2');
    const tx = itemsOf(ddbMock.commandCalls(TransactWriteCommand)[0].args[0]);
    expect(tx[0].Update).toMatchObject({
      Key: { pk: 'EVENT#E1', sk: 'BIB#AUS-1147' },
      ConditionExpression: '#revision < :rev',
      ExpressionAttributeNames: { '#revision': 'revision', '#status': 'status' },
      ExpressionAttributeValues: { ':rev': 4, ':status': 'OFFICIAL' },
    });
    expect(tx[1].Update?.UpdateExpression).toBe('ADD updatesAccepted :one');
    expect(tx[2].Put?.Item).toMatchObject({ pk: 'DELIVERY#req-2', outcome: 'ACCEPTED', ttl: TTL });
  });

  it('ignores with a condition check, an ignored counter and a delivery marker', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    await store().recordIgnored(update, 'req-3');
    const tx = itemsOf(ddbMock.commandCalls(TransactWriteCommand)[0].args[0]);
    expect(tx[0].ConditionCheck).toMatchObject({
      Key: { pk: 'EVENT#E1', sk: 'BIB#AUS-1147' },
      ConditionExpression: '#revision >= :rev',
      ExpressionAttributeNames: { '#revision': 'revision' },
      ExpressionAttributeValues: { ':rev': 4 },
    });
    expect(tx[1].Update?.UpdateExpression).toBe('ADD updatesIgnored :one');
    expect(tx[2].Put?.Item).toMatchObject({ outcome: 'IGNORED', pk: 'DELIVERY#req-3' });
  });

  it('counts a rejection on the global stats item', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    await store().recordRejected('req-4');
    const tx = itemsOf(ddbMock.commandCalls(TransactWriteCommand)[0].args[0]);
    expect(tx[0].Update).toMatchObject({
      Key: { pk: 'GLOBAL', sk: 'STATS' },
      UpdateExpression: 'ADD updatesRejected :one',
    });
    expect(tx[1].Put?.Item).toMatchObject({ pk: 'DELIVERY#req-4', outcome: 'REJECTED', ttl: TTL });
  });
});

describe('DynamoStore cancellation mapping', () => {
  it('treats a failed delivery condition as already processed, ahead of any other failure', async () => {
    ddbMock.on(TransactWriteCommand).rejects(canceled([
      { Code: 'ConditionalCheckFailed' },
      { Code: 'None' },
      { Code: 'None' },
      { Code: 'ConditionalCheckFailed' },
    ]));
    ddbMock.on(GetCommand).resolves({ Item: { outcome: 'ACCEPTED' } });
    expect(await store().createAthlete(update, 'req-1')).toEqual({ kind: 'ALREADY_PROCESSED', outcome: 'ACCEPTED' });
    expect(ddbMock.commandCalls(GetCommand)[0].args[0].input).toEqual({
      TableName: 'pv4',
      Key: { pk: 'DELIVERY#req-1', sk: 'DELIVERY' },
      ConsistentRead: true,
    });
  });

  it('retries when a non-delivery condition fails', async () => {
    ddbMock.on(TransactWriteCommand).rejects(canceled([
      { Code: 'ConditionalCheckFailed' },
      { Code: 'None' },
      { Code: 'None' },
    ]));
    expect(await store().advanceAthlete(update, 'req-2')).toEqual({ kind: 'RETRY', reason: 'CONDITION_FAILED' });
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('retries on transaction conflict', async () => {
    ddbMock.on(TransactWriteCommand).rejects(canceled([
      { Code: 'None' },
      { Code: 'TransactionConflict' },
    ]));
    expect(await store().recordRejected('req-4')).toEqual({ kind: 'RETRY', reason: 'CONFLICT' });
  });

  it('retries throttling and network errors, and rethrows anything else', async () => {
    const s = store();
    ddbMock.on(TransactWriteCommand).rejectsOnce(named('ThrottlingException'));
    expect(await s.recordRejected('req-5')).toEqual({ kind: 'RETRY', reason: 'TRANSIENT' });

    ddbMock.reset();
    ddbMock.on(TransactWriteCommand).rejects(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
    expect(await s.recordRejected('req-6')).toEqual({ kind: 'RETRY', reason: 'TRANSIENT' });

    ddbMock.reset();
    ddbMock.on(TransactWriteCommand).rejects(named('ValidationException', 'bad'));
    await expect(s.recordRejected('req-7')).rejects.toThrow('bad');
  });
});

function canceled(reasons: { Code: string }[]) {
  return new TransactionCanceledException({
    message: 'cancelled',
    $metadata: {},
    CancellationReasons: reasons,
  });
}

function named(name: string, message = name) {
  const err = new Error(message);
  err.name = name;
  return err;
}
