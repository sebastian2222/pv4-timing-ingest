/**
 * A local fake of the deployed stack, for developing the page and checking the e2e harness.
 *   npm run dev        → http://localhost:4000
 *
 *   POST /timing       ingest (same parse → validate → decide path as the Lambda)
 *   POST /graphql      the exact contract from schema.graphql (x-api-key: local-key)
 *   GET  /             the results page from web/, with a config.json pointing here
 *
 * State lives in memory (ReferenceStore). Logs are the same structured JSON + EMF lines the
 * Lambda writes, so you can see what CloudWatch will receive.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { buildSchema, graphql } from 'graphql';
import { ReferenceStore } from '../src/model';
import { parseBody } from '../src/parseBody';
import { validateUpdate } from '../src/validate';
import { createLogger } from '../src/obs';

const PORT = Number(process.env.PORT ?? 4000);
const API_KEY = 'local-key';
const root = join(import.meta.dirname, '..');
const schema = buildSchema(readFileSync(join(root, 'schema.graphql'), 'utf8'));
const store = new ReferenceStore();
const log = createLogger({ service: 'pv4-ingest' });

const rootValue = {
  events: () => store.events(),
  results: ({ eventId }: { eventId: string }) => store.results(eventId),
  eventStats: ({ eventId }: { eventId: string }) => store.eventStats(eventId),
  updatesRejected: () => store.updatesRejected(),
};

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, {
    'content-type': type,
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,x-api-key',
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (req.method === 'POST' && url.pathname === '/timing') {
    const requestId = randomUUID();
    const parsed = parseBody({ body: await readBody(req) });
    if (!parsed.ok) {
      store.rejectUnparseable(parsed.raw);
      log.child({ requestId }).outcome('REJECTED', { reason: parsed.reason });
      return send(res, 400, { outcome: 'REJECTED', requestId, errors: [{ field: '$', reason: parsed.reason }] });
    }
    const v = validateUpdate(parsed.value);
    // Best-effort trace context even for corrupt updates, so a bib's rejections show up in its trace.
    const p = (parsed.value ?? {}) as Record<string, unknown>;
    const ctx = { requestId, eventId: p.eventId, bib: p.bib, revision: p.revision, status: p.status };
    const stored = v.ok ? store.results(v.update.eventId).find((r) => r.bib === v.update.bib)?.revision : undefined;
    const outcome = store.ingest(parsed.value, requestId);
    const l = log.child(ctx);
    if (outcome === 'REJECTED') {
      l.outcome('REJECTED', { errors: v.ok ? [] : v.errors });
      return send(res, 400, { outcome, requestId, errors: v.ok ? [] : v.errors });
    }
    l.outcome(outcome as 'ACCEPTED' | 'IGNORED', outcome === 'IGNORED'
      ? { storedRevision: stored, reason: stored === (p.revision as number) ? 'DUPLICATE_OR_SAME_REVISION' : 'STALE' }
      : { previousRevision: stored ?? null });
    return send(res, 200, { outcome, requestId });
  }

  if (req.method === 'POST' && url.pathname === '/graphql') {
    if (req.headers['x-api-key'] !== API_KEY) return send(res, 401, { errors: [{ message: 'UnauthorizedException' }] });
    const { query, variables } = JSON.parse(await readBody(req));
    return send(res, 200, await graphql({ schema, source: query, rootValue, variableValues: variables }));
  }

  if (req.method === 'GET' && url.pathname === '/config.json') {
    return send(res, 200, { graphqlUrl: `http://localhost:${PORT}/graphql`, apiKey: API_KEY });
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return send(res, 200, readFileSync(join(root, 'web', 'index.html'), 'utf8'), 'text/html; charset=utf-8');
  }

  send(res, 404, { message: 'not found' });
}).listen(PORT, () => {
  process.stderr.write(`local stack on http://localhost:${PORT}  (ingest: /timing, graphql: /graphql, key: ${API_KEY})\n`);
});
