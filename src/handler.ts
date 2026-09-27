import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { S3DeadLetter } from './deadLetter';
import { DynamoStore } from './dynamoStore';
import { createLogger } from './obs';
import { processUpdate, type ProcessDeps, type ProcessResult } from './processor';

// Clients are created once per warm environment and reused. Building them
// inside the handler would open a new connection on every update.
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const log = createLogger({ service: 'pv4-ingest' });

export async function handleRequest(event: APIGatewayProxyEventV2, deps: ProcessDeps): Promise<ProcessResult> {
  const requestId = event.requestContext.requestId;
  try {
    return await processUpdate({
      body: event.body,
      isBase64Encoded: event.isBase64Encoded,
      requestId,
    }, deps);
  } catch (err) {
    // Bad input is rejected inside processUpdate. Anything that still throws
    // is infrastructure, and it must not become an unhandled Lambda error
    // with an empty body.
    log.error('unhandled processor error', { requestId, err });
    log.metric('ProcessingFailures', 1, 'Count', { requestId });
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'FAILED', requestId }),
    };
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const tableName = process.env.TABLE_NAME;
  const bucket = process.env.DEAD_LETTER_BUCKET;
  if (!tableName || !bucket) throw new Error('TABLE_NAME and DEAD_LETTER_BUCKET are required');
  return handleRequest(event, {
    store: new DynamoStore(doc, tableName),
    deadLetter: new S3DeadLetter(s3, bucket),
    log,
  });
}
