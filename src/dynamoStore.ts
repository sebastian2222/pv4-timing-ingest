import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { TimingUpdate } from './validate';
import type { Outcome, Store, StoredAthlete, TxResult } from './store';

const TRANSIENT_NAMES = new Set([
  'ProvisionedThroughputExceeded',
  'ProvisionedThroughputExceededException',
  'ThrottlingException',
  'InternalServerError',
  'RequestLimitExceeded',
  'ServiceUnavailable',
]);

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']);

/**
 * DynamoDB implementation of Store. Every state change, counter change and
 * delivery marker is one TransactWriteItems, so they commit together or not
 * at all. The condition on the athlete item is what makes ordering safe under
 * concurrency; the read in the processor is only a hint.
 */
export class DynamoStore implements Store {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getAthlete(eventId: string, bib: string): Promise<StoredAthlete | undefined> {
    const res = await this.doc.send(new GetCommand({
      TableName: this.tableName,
      Key: athleteKey(eventId, bib),
      ConsistentRead: true,
    }));
    const item = res.Item;
    if (!item) return undefined;
    return { revision: item.revision as number, status: item.status as string, lane: item.lane as number, timeMs: item.timeMs as number };
  }

  createAthlete(u: TimingUpdate, requestId: string): Promise<TxResult> {
    const updatedAt = this.now().toISOString();
    return this.write(requestId, 3, [
      {
        Put: {
          TableName: this.tableName,
          Item: { ...athleteKey(u.eventId, u.bib), eventId: u.eventId, bib: u.bib, lane: u.lane, revision: u.revision, status: u.status, timeMs: u.timeMs, updatedAt },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Update: {
          TableName: this.tableName,
          Key: { pk: `EVENT#${u.eventId}`, sk: 'STATS' },
          UpdateExpression: 'ADD updatesAccepted :one, athletesTracked :one SET eventId = :eventId',
          ExpressionAttributeValues: { ':one': 1, ':eventId': u.eventId },
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: { pk: 'EVENTS', sk: `EVENT#${u.eventId}`, eventId: u.eventId, firstSeenAt: updatedAt },
        },
      },
      deliveryPut(this.tableName, requestId, 'ACCEPTED', this.ttl()),
    ]);
  }

  advanceAthlete(u: TimingUpdate, requestId: string): Promise<TxResult> {
    return this.write(requestId, 2, [
      {
        Update: {
          TableName: this.tableName,
          Key: athleteKey(u.eventId, u.bib),
          UpdateExpression: 'SET eventId = :eventId, bib = :bib, lane = :lane, #revision = :rev, #status = :status, timeMs = :timeMs, updatedAt = :updatedAt',
          ConditionExpression: '#revision < :rev',
          ExpressionAttributeNames: { '#revision': 'revision', '#status': 'status' },
          ExpressionAttributeValues: {
            ':eventId': u.eventId, ':bib': u.bib, ':lane': u.lane, ':rev': u.revision,
            ':status': u.status, ':timeMs': u.timeMs, ':updatedAt': this.now().toISOString(),
          },
        },
      },
      {
        Update: {
          TableName: this.tableName,
          Key: { pk: `EVENT#${u.eventId}`, sk: 'STATS' },
          UpdateExpression: 'ADD updatesAccepted :one',
          ExpressionAttributeValues: { ':one': 1 },
        },
      },
      deliveryPut(this.tableName, requestId, 'ACCEPTED', this.ttl()),
    ]);
  }

  recordIgnored(u: TimingUpdate, requestId: string): Promise<TxResult> {
    return this.write(requestId, 2, [
      {
        ConditionCheck: {
          TableName: this.tableName,
          Key: athleteKey(u.eventId, u.bib),
          ConditionExpression: '#revision >= :rev',
          ExpressionAttributeNames: { '#revision': 'revision' },
          ExpressionAttributeValues: { ':rev': u.revision },
        },
      },
      {
        Update: {
          TableName: this.tableName,
          Key: { pk: `EVENT#${u.eventId}`, sk: 'STATS' },
          UpdateExpression: 'ADD updatesIgnored :one',
          ExpressionAttributeValues: { ':one': 1 },
        },
      },
      deliveryPut(this.tableName, requestId, 'IGNORED', this.ttl()),
    ]);
  }

  recordRejected(requestId: string): Promise<TxResult> {
    return this.write(requestId, 1, [
      {
        Update: {
          TableName: this.tableName,
          Key: { pk: 'GLOBAL', sk: 'STATS' },
          UpdateExpression: 'ADD updatesRejected :one',
          ExpressionAttributeValues: { ':one': 1 },
        },
      },
      deliveryPut(this.tableName, requestId, 'REJECTED', this.ttl()),
    ]);
  }

  private ttl(): number {
    return Math.floor(this.now().getTime() / 1000) + 86_400;
  }

  private async write(requestId: string, deliveryIndex: number, TransactItems: ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']): Promise<TxResult> {
    try {
      await this.doc.send(new TransactWriteCommand({ TransactItems }));
      return { kind: 'COMMITTED' };
    } catch (err) {
      if (isCanceled(err)) {
        const reasons = err.CancellationReasons ?? [];
        // Delivery marker first: a lost response must not be counted again,
        // even when the athlete condition would also fail on the retry.
        if (reasons[deliveryIndex]?.Code === 'ConditionalCheckFailed') {
          const marker = await this.doc.send(new GetCommand({
            TableName: this.tableName,
            Key: deliveryKey(requestId),
            ConsistentRead: true,
          }));
          const outcome = marker.Item?.outcome;
          if (outcome === 'ACCEPTED' || outcome === 'IGNORED' || outcome === 'REJECTED') {
            return { kind: 'ALREADY_PROCESSED', outcome };
          }
          throw err;
        }
        if (reasons.some((r) => r.Code === 'ConditionalCheckFailed')) return { kind: 'RETRY', reason: 'CONDITION_FAILED' };
        if (reasons.some((r) => r.Code === 'TransactionConflict')) return { kind: 'RETRY', reason: 'CONFLICT' };
        throw err;
      }
      if (isTransient(err)) return { kind: 'RETRY', reason: 'TRANSIENT' };
      throw err;
    }
  }
}

function athleteKey(eventId: string, bib: string) {
  return { pk: `EVENT#${eventId}`, sk: `BIB#${bib}` };
}

function deliveryKey(requestId: string) {
  return { pk: `DELIVERY#${requestId}`, sk: 'DELIVERY' };
}

function deliveryPut(tableName: string, requestId: string, outcome: Outcome, ttl: number) {
  return {
    Put: {
      TableName: tableName,
      Item: { ...deliveryKey(requestId), outcome, ttl },
      ConditionExpression: 'attribute_not_exists(pk)',
    },
  };
}

function isCanceled(err: unknown): err is { CancellationReasons?: { Code?: string }[] } {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'TransactionCanceledException';
}

function isTransient(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const named = err as { name?: string; code?: string };
  if (named.name && TRANSIENT_NAMES.has(named.name)) return true;
  if (named.code && NETWORK_CODES.has(named.code)) return true;
  return false;
}
