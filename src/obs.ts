/**
 * Structured JSON logging + CloudWatch custom metrics via Embedded Metric Format (EMF).
 *
 * Why EMF: a log line that carries an `_aws` block is turned into a metric by CloudWatch
 * itself. No PutMetricData call, no extra latency, no extra IAM, and the metric and the
 * log line describing it are literally the same record.
 *
 * Why process.stdout.write and not console.log: the Lambda Node runtime prefixes console.log
 * output with "<timestamp> <requestId> INFO", which stops the line being pure JSON.
 *
 * Why hand-rolled and not Powertools: ~80 lines I can explain end to end. Powertools
 * (Logger + Metrics) is the production choice; it produces the same output shape.
 */

export const METRIC_NAMESPACE = 'PV4/Timing';
export const OUTCOME_METRIC = {
  ACCEPTED: 'UpdatesAccepted',
  IGNORED: 'UpdatesIgnored',
  REJECTED: 'UpdatesRejected',
} as const;

export type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type Outcome = keyof typeof OUTCOME_METRIC;
type Fields = Record<string, unknown>;

export interface Logger {
  child(fields: Fields): Logger;
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  /** One line that is both the audit log entry and the metric for this update's fate. */
  outcome(outcome: Outcome, fields?: Fields): void;
  metric(name: string, value: number, unit?: string, fields?: Fields): void;
}

interface Opts {
  sink?: (line: string) => void;
  now?: () => number;
  maxValueChars?: number;
}

const defaultSink = (line: string) => { process.stdout.write(line + '\n'); };

function safeStringify(obj: unknown, maxValueChars: number): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(obj, (_k, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack?.split('\n').slice(0, 5).join('\n') };
    if (typeof v === 'string' && v.length > maxValueChars) return `${v.slice(0, maxValueChars)}…[truncated ${v.length - maxValueChars} chars]`;
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
    }
    return v;
  });
}

export function createLogger(base: Fields, opts: Opts = {}): Logger {
  const sink = opts.sink ?? defaultSink;
  const now = opts.now ?? Date.now;
  const maxValueChars = opts.maxValueChars ?? 2_000;

  const write = (record: Fields) => {
    try {
      sink(safeStringify(record, maxValueChars));
    } catch {
      // Logging must never take the processor down. Swallow and carry on.
    }
  };

  const line = (level: Level, msg: string, fields: Fields = {}) =>
    write({ ts: new Date(now()).toISOString(), level, msg, ...base, ...fields });

  const emf = (level: Level, msg: string, metrics: Record<string, [number, string]>, fields: Fields = {}) => {
    const service = String(base.service ?? 'unknown');
    const metricValues = Object.fromEntries(Object.entries(metrics).map(([n, [v]]) => [n, v]));
    write({
      ts: new Date(now()).toISOString(),
      level,
      msg,
      ...base,
      ...fields,
      // Everything below is written last so callers cannot clobber it.
      Service: service,
      ...metricValues,
      _aws: {
        Timestamp: now(),
        CloudWatchMetrics: [{
          Namespace: METRIC_NAMESPACE,
          // Low-cardinality dimension only. eventId/bib stay as searchable fields, not dimensions:
          // every distinct dimension value is a separately billed metric.
          Dimensions: [['Service']],
          Metrics: Object.entries(metrics).map(([Name, [, Unit]]) => ({ Name, Unit })),
        }],
      },
    });
  };

  return {
    child: (fields) => createLogger({ ...base, ...fields }, opts),
    debug: (m, f) => line('DEBUG', m, f),
    info: (m, f) => line('INFO', m, f),
    warn: (m, f) => line('WARN', m, f),
    error: (m, f) => line('ERROR', m, f),
    outcome: (outcome, fields = {}) =>
      emf(outcome === 'REJECTED' ? 'WARN' : 'INFO', `update ${outcome.toLowerCase()}`,
        { [OUTCOME_METRIC[outcome]]: [1, 'Count'] }, { ...fields, outcome }),
    metric: (name, value, unit = 'Count', fields = {}) => emf('INFO', `metric ${name}`, { [name]: [value, unit] }, fields),
  };
}
