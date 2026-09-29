import { describe, it, expect, beforeEach } from 'vitest';
import { createLogger, METRIC_NAMESPACE, OUTCOME_METRIC } from '../src/obs';

let lines: string[];
const sink = (l: string) => lines.push(l);
const parse = () => lines.map((l) => JSON.parse(l));
const NOW = 1_790_000_000_000;

beforeEach(() => { lines = []; });

describe('structured JSON logs', () => {
  it('writes exactly one JSON object per line', () => {
    const log = createLogger({ service: 'pv4-ingest' }, { sink, now: () => NOW });
    log.info('hello', { a: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'INFO', msg: 'hello', service: 'pv4-ingest', a: 1 });
  });

  it('includes an ISO timestamp', () => {
    const log = createLogger({}, { sink, now: () => NOW });
    log.info('x');
    expect(parse()[0].ts).toBe(new Date(NOW).toISOString());
  });

  it('child() carries trace context onto every later line — this is how one bib is traced', () => {
    const root = createLogger({ service: 'pv4-ingest' }, { sink, now: () => NOW });
    const log = root.child({ requestId: 'req-1', eventId: 'E', bib: 'AUS-1147', revision: 4 });
    log.info('validated');
    log.info('applied', { outcome: 'ACCEPTED' });
    for (const l of parse()) {
      expect(l).toMatchObject({ service: 'pv4-ingest', requestId: 'req-1', eventId: 'E', bib: 'AUS-1147', revision: 4 });
    }
  });

  it('child() does not mutate the parent', () => {
    const root = createLogger({ service: 's' }, { sink, now: () => NOW });
    root.child({ bib: 'B' });
    root.info('x');
    expect(parse()[0].bib).toBeUndefined();
  });

  it('never throws, even on circular or BigInt fields — logging must not crash the processor', () => {
    const log = createLogger({}, { sink, now: () => NOW });
    const circ: Record<string, unknown> = { a: 1 };
    circ.self = circ;
    expect(() => log.info('circular', { circ, big: BigInt(10) })).not.toThrow();
    expect(parse()[0].msg).toBe('circular');
  });

  it('never throws even if the sink throws', () => {
    const log = createLogger({}, { sink: () => { throw new Error('stdout closed'); }, now: () => NOW });
    expect(() => log.info('x')).not.toThrow();
  });

  it('serialises Error objects usefully', () => {
    const log = createLogger({}, { sink, now: () => NOW });
    log.error('boom', { err: new Error('bad thing') });
    expect(parse()[0].err).toMatchObject({ name: 'Error', message: 'bad thing' });
  });

  it('truncates huge values so one corrupt 1 MB payload cannot flood the logs', () => {
    const log = createLogger({}, { sink, now: () => NOW });
    log.warn('rejected', { raw: 'x'.repeat(100_000) });
    expect(lines[0].length).toBeLessThan(5_000);
    expect(parse()[0].raw).toContain('…[truncated');
  });
});

describe('custom metrics via Embedded Metric Format (EMF)', () => {
  it('outcome() writes a log line that is also a CloudWatch metric', () => {
    const log = createLogger({ service: 'pv4-ingest' }, { sink, now: () => NOW }).child({ eventId: 'E', bib: 'B', revision: 2 });
    log.outcome('ACCEPTED');
    const l = parse()[0];
    expect(l._aws).toEqual({
      Timestamp: NOW,
      CloudWatchMetrics: [{
        Namespace: METRIC_NAMESPACE,
        Dimensions: [['Service']],
        Metrics: [{ Name: 'UpdatesAccepted', Unit: 'Count' }],
      }],
    });
    expect(l.UpdatesAccepted).toBe(1);
    expect(l.Service).toBe('pv4-ingest');
    // Trace context is still on the line, so the metric and the log are the same record
    expect(l).toMatchObject({ eventId: 'E', bib: 'B', revision: 2, outcome: 'ACCEPTED' });
  });

  it.each([
    ['ACCEPTED', 'UpdatesAccepted'],
    ['IGNORED', 'UpdatesIgnored'],
    ['REJECTED', 'UpdatesRejected'],
  ] as const)('%s → %s', (outcome, metric) => {
    expect(OUTCOME_METRIC[outcome]).toBe(metric);
    createLogger({ service: 's' }, { sink, now: () => NOW }).outcome(outcome);
    expect(parse()[0][metric]).toBe(1);
  });

  it('never uses eventId or bib as a dimension (unbounded cardinality = cost)', () => {
    createLogger({ service: 's' }, { sink, now: () => NOW }).child({ eventId: 'E', bib: 'B' }).outcome('IGNORED');
    const dims = parse()[0]._aws.CloudWatchMetrics[0].Dimensions.flat();
    expect(dims).toEqual(['Service']);
  });

  it('a metric field cannot be overwritten by a caller field of the same name', () => {
    createLogger({ service: 's' }, { sink, now: () => NOW }).outcome('ACCEPTED', { UpdatesAccepted: 999 });
    expect(parse()[0].UpdatesAccepted).toBe(1);
  });

  it('metric() emits an arbitrary counter (e.g. transaction conflict retries)', () => {
    createLogger({ service: 's' }, { sink, now: () => NOW }).metric('TransactionConflictRetries', 2, 'Count', { attempt: 3 });
    const l = parse()[0];
    expect(l.TransactionConflictRetries).toBe(2);
    expect(l._aws.CloudWatchMetrics[0].Metrics).toEqual([{ Name: 'TransactionConflictRetries', Unit: 'Count' }]);
    expect(l.attempt).toBe(3);
  });

  it('IGNORED lines explain why (stored revision vs incoming)', () => {
    createLogger({ service: 's' }, { sink, now: () => NOW })
      .child({ bib: 'B', revision: 2 })
      .outcome('IGNORED', { storedRevision: 3, reason: 'STALE' });
    expect(parse()[0]).toMatchObject({ outcome: 'IGNORED', revision: 2, storedRevision: 3, reason: 'STALE', level: 'INFO' });
  });

  it('REJECTED lines are WARN, not ERROR — 10% corruption is expected, not an incident', () => {
    createLogger({ service: 's' }, { sink, now: () => NOW }).outcome('REJECTED', { errors: [{ field: 'status' }] });
    expect(parse()[0].level).toBe('WARN');
  });
});
