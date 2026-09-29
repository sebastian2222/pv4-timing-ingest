import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { FakeStore } from '../src/fakeStore';
import { handleRequest } from '../src/handler';
import { createLogger } from '../src/obs';
import type { ProcessDeps } from '../src/processor';

function event(body: string | undefined, requestId = 'req-from-context', isBase64Encoded = false): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /timing',
    rawPath: '/timing',
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    isBase64Encoded,
    body,
    requestContext: {
      accountId: '111111111111',
      apiId: 'api',
      domainName: 'example.com',
      domainPrefix: 'example',
      requestId,
      routeKey: 'POST /timing',
      stage: '$default',
      time: '01/Jan/2026:00:00:00 +0000',
      timeEpoch: 0,
      http: { method: 'POST', path: '/timing', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
    },
  };
}

function deps(store = new FakeStore()): ProcessDeps & { store: FakeStore } {
  return {
    store,
    deadLetter: { put: async (record) => `rejected/2026-08-25/${record.requestId}.json` },
    log: createLogger({ service: 'pv4-ingest' }, { sink: () => {} }),
    sleep: async () => {},
  };
}

const valid = JSON.stringify({
  eventId: 'UNIT-M100', bib: 'AUS-1147', lane: 3, revision: 1, status: 'PROVISIONAL', timeMs: 10105,
});

describe('ingest handler', () => {
  it('accepts a JSON body and uses the API Gateway request id', async () => {
    const d = deps();
    const res = await handleRequest(event(valid, 'gw-123'), d);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ outcome: 'ACCEPTED', requestId: 'gw-123' });
    expect(d.store.snapshot().eventStats('UNIT-M100').updatesAccepted).toBe(1);
  });

  it('accepts a base64 body', async () => {
    const d = deps();
    const res = await handleRequest(event(Buffer.from(valid).toString('base64'), 'gw-b64', true), d);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).outcome).toBe('ACCEPTED');
  });

  it('rejects a missing body and counts it', async () => {
    const d = deps();
    const res = await handleRequest(event(undefined, 'gw-empty'), d);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).requestId).toBe('gw-empty');
    expect(d.store.snapshot().updatesRejected).toBe(1);
  });

  it('turns an unexpected store failure into 503', async () => {
    const d = deps();
    d.store.getAthlete = async () => { throw new Error('dynamo exploded'); };
    const res = await handleRequest(event(valid, 'gw-down'), d);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ outcome: 'FAILED', requestId: 'gw-down' });
  });
});
