import { describe, expect, it, vi } from 'vitest';

vi.mock('@aws-appsync/utils', () => ({
  util: {
    dynamodb: {
      toMapValues: (values: Record<string, unknown>) => values,
    },
    error: (message: string) => { throw new Error(message); },
  },
}));

const events = await import('../resolvers/events.js');
const results = await import('../resolvers/results.js');
const eventStats = await import('../resolvers/eventStats.js');
const updatesRejected = await import('../resolvers/updatesRejected.js');

describe('AppSync resolvers', () => {
  it('events queries the registry with a consistent read', () => {
    const req = events.request({});
    expect(req.operation).toBe('Query');
    expect(req.consistentRead).toBe(true);
    expect(req.query).toEqual({
      expression: 'pk = :pk',
      expressionValues: { ':pk': 'EVENTS' },
    });
    expect(events.response({ result: { items: [{ eventId: 'E1' }, { eventId: 'E2' }] } })).toEqual(['E1', 'E2']);
    expect(events.response({ result: { items: [] } })).toEqual([]);
    expect(events.response({ result: null })).toEqual([]);
    expect(() => events.response({ error: { message: 'boom', type: 'DynamoDB' } })).toThrow('boom');
  });

  it('results queries BIB items for the event', () => {
    const req = results.request({ args: { eventId: 'E1' } });
    expect(req.operation).toBe('Query');
    expect(req.consistentRead).toBe(true);
    expect(req.limit).toBe(1000);
    expect(req.query.expressionValues).toEqual({ ':pk': 'EVENT#E1', ':prefix': 'BIB#' });
    expect(results.response({
      result: { items: [{ bib: 'A', lane: 1, revision: 2, status: 'OFFICIAL', timeMs: 100, extra: true }] },
    })).toEqual([{ bib: 'A', lane: 1, revision: 2, status: 'OFFICIAL', timeMs: 100 }]);
    expect(results.response({ result: null })).toEqual([]);
    expect(() => results.response({ error: { message: 'boom', type: 'DynamoDB' } })).toThrow('boom');
  });

  it('eventStats returns zeros when the event has not been seen', () => {
    const req = eventStats.request({ args: { eventId: 'E1' } });
    expect(req.operation).toBe('GetItem');
    expect(req.consistentRead).toBe(true);
    expect(req.key).toEqual({ pk: 'EVENT#E1', sk: 'STATS' });
    expect(eventStats.response({ args: { eventId: 'E1' }, result: null })).toEqual({
      eventId: 'E1', athletesTracked: 0, updatesAccepted: 0, updatesIgnored: 0,
    });
    expect(eventStats.response({
      args: { eventId: 'E1' },
      result: { athletesTracked: 2, updatesAccepted: 5, updatesIgnored: 1 },
    })).toEqual({ eventId: 'E1', athletesTracked: 2, updatesAccepted: 5, updatesIgnored: 1 });
    expect(() => eventStats.response({ error: { message: 'boom', type: 'DynamoDB' } })).toThrow('boom');
  });

  it('updatesRejected reads the global counter and defaults to 0', () => {
    const req = updatesRejected.request();
    expect(req.operation).toBe('GetItem');
    expect(req.consistentRead).toBe(true);
    expect(req.key).toEqual({ pk: 'GLOBAL', sk: 'STATS' });
    expect(updatesRejected.response({ result: null })).toBe(0);
    expect(updatesRejected.response({ result: { updatesRejected: 4 } })).toBe(4);
    expect(() => updatesRejected.response({ error: { message: 'boom', type: 'DynamoDB' } })).toThrow('boom');
  });
});
