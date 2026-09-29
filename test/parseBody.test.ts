import { describe, it, expect } from 'vitest';
import { parseBody } from '../src/parseBody';

// Shapes of what API Gateway (HTTP API / REST) or a Lambda Function URL hand you.
describe('parseBody — raw HTTP body to unknown JSON', () => {
  it('parses a plain JSON string body', () => {
    const r = parseBody({ body: '{"a":1}', isBase64Encoded: false });
    expect(r).toEqual({ ok: true, value: { a: 1 } });
  });

  it('decodes base64 bodies (HTTP APIs do this for some content types)', () => {
    const b64 = Buffer.from('{"a":1}').toString('base64');
    expect(parseBody({ body: b64, isBase64Encoded: true })).toEqual({ ok: true, value: { a: 1 } });
  });

  it.each([
    ['missing body', { body: undefined }],
    ['null body', { body: null }],
    ['empty string', { body: '' }],
    ['truncated JSON', { body: '{"eventId":"E","bib":' }],
    ['trailing comma', { body: '{"a":1,}' }],
    ['not JSON at all', { body: 'eventId=E&bib=B' }],
    ['NaN literal', { body: '{"timeMs":NaN}' }],
    ['bad base64 → garbage', { body: '%%%%', isBase64Encoded: true }],
  ])('fails cleanly (no throw) on %s', (_label, ev) => {
    const r = parseBody(ev as never);
    expect(r.ok).toBe(false);
  });

  it('keeps the raw text on failure so it can be dead-lettered', () => {
    const r = parseBody({ body: '{"broken"', isBase64Encoded: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.raw).toBe('{"broken"');
  });

  it('parses valid JSON that is not an object — validation rejects it later, not the parser', () => {
    expect(parseBody({ body: 'null' })).toEqual({ ok: true, value: null });
    expect(parseBody({ body: '[1,2]' })).toEqual({ ok: true, value: [1, 2] });
  });

  it('strips a UTF-8 BOM', () => {
    expect(parseBody({ body: '﻿{"a":1}' })).toEqual({ ok: true, value: { a: 1 } });
  });
});
