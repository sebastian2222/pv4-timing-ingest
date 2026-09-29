import { describe, it, expect } from 'vitest';
import { validateUpdate } from '../src/validate';

const good = {
  eventId: 'WC26-ATH-M100M-SF2',
  bib: 'AUS-1147',
  lane: 3,
  revision: 2,
  status: 'CONFIRMED',
  timeMs: 10105,
  recordedAt: '2026-08-25T19:42:07.000Z',
};

const withField = (k: string, v: unknown) => ({ ...good, [k]: v });
const without = (k: string) => {
  const c: Record<string, unknown> = { ...good };
  delete c[k];
  return c;
};

describe('validateUpdate — happy path', () => {
  it('accepts the exact example from the brief', () => {
    const r = validateUpdate(good);
    expect(r.ok).toBe(true);
  });

  it('returns only the known fields (extra fields are ignored, not stored)', () => {
    const r = validateUpdate({ ...good, hacker: 'x', __typename: 'Result' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.update).sort()).toEqual(
      ['bib', 'eventId', 'lane', 'recordedAt', 'revision', 'status', 'timeMs'].sort(),
    );
  });

  it.each(['PROVISIONAL', 'CONFIRMED', 'OFFICIAL'])('accepts status %s', (s) => {
    expect(validateUpdate(withField('status', s)).ok).toBe(true);
  });

  it('accepts revision = 1 (lower bound)', () => {
    expect(validateUpdate(withField('revision', 1)).ok).toBe(true);
  });

  it('accepts timeMs = 1 (lower bound)', () => {
    expect(validateUpdate(withField('timeMs', 1)).ok).toBe(true);
  });

  it('accepts lane = 0 and negative lanes (brief only says "integer")', () => {
    expect(validateUpdate(withField('lane', 0)).ok).toBe(true);
    expect(validateUpdate(withField('lane', -1)).ok).toBe(true);
  });

  it('accepts 3.0 because JSON.parse makes it the integer 3', () => {
    const parsed = JSON.parse('{"eventId":"E","bib":"B","lane":3.0,"revision":1.0,"status":"OFFICIAL","timeMs":9990.0}');
    expect(validateUpdate(parsed).ok).toBe(true);
  });

  describe('recordedAt is NOT validated', () => {
    it.each([
      ['missing', undefined],
      ['garbage string', 'not-a-date'],
      ['number', 12345],
      ['null', null],
      ['far future', '2099-01-01T00:00:00Z'],
    ])('accepts recordedAt %s', (_label, v) => {
      const u = v === undefined ? without('recordedAt') : withField('recordedAt', v);
      expect(validateUpdate(u).ok).toBe(true);
    });
  });
});

describe('validateUpdate — not an object at all', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['array', [good]],
    ['string', 'hello'],
    ['number', 42],
    ['boolean', true],
    ['empty object', {}],
  ])('rejects %s', (_label, v) => {
    const r = validateUpdate(v);
    expect(r.ok).toBe(false);
  });
});

describe('validateUpdate — required fields', () => {
  it.each(['eventId', 'bib', 'lane', 'revision', 'status', 'timeMs'])('rejects when %s is missing', (k) => {
    expect(validateUpdate(without(k)).ok).toBe(false);
  });

  it.each(['eventId', 'bib', 'lane', 'revision', 'status', 'timeMs'])('rejects when %s is null', (k) => {
    expect(validateUpdate(withField(k, null)).ok).toBe(false);
  });
});

describe('validateUpdate — eventId / bib', () => {
  it.each(['eventId', 'bib'])('rejects empty string %s', (k) => {
    expect(validateUpdate(withField(k, '')).ok).toBe(false);
  });
  it.each(['eventId', 'bib'])('rejects whitespace-only %s (decision — see DECISIONS.md)', (k) => {
    expect(validateUpdate(withField(k, '   ')).ok).toBe(false);
  });
  it.each(['eventId', 'bib'])('rejects non-string %s', (k) => {
    expect(validateUpdate(withField(k, 1147)).ok).toBe(false);
    expect(validateUpdate(withField(k, ['AUS'])).ok).toBe(false);
    expect(validateUpdate(withField(k, { id: 'AUS' })).ok).toBe(false);
  });
});

describe('validateUpdate — integer fields', () => {
  const ints = ['lane', 'revision', 'timeMs'];
  it.each(ints)('rejects %s as numeric string', (k) => {
    expect(validateUpdate(withField(k, '3')).ok).toBe(false);
  });
  it.each(ints)('rejects %s as float', (k) => {
    expect(validateUpdate(withField(k, 3.5)).ok).toBe(false);
  });
  it.each(ints)('rejects %s as boolean', (k) => {
    expect(validateUpdate(withField(k, true)).ok).toBe(false);
  });
  it.each(ints)('rejects %s above GraphQL Int (2^31-1) — it could never be served', (k) => {
    expect(validateUpdate(withField(k, 2 ** 31)).ok).toBe(false);
  });

  it('rejects revision 0 and negative', () => {
    expect(validateUpdate(withField('revision', 0)).ok).toBe(false);
    expect(validateUpdate(withField('revision', -1)).ok).toBe(false);
  });
  it('rejects timeMs 0 and negative', () => {
    expect(validateUpdate(withField('timeMs', 0)).ok).toBe(false);
    expect(validateUpdate(withField('timeMs', -10105)).ok).toBe(false);
  });
  it('accepts values exactly at 2^31-1', () => {
    expect(validateUpdate(withField('timeMs', 2 ** 31 - 1)).ok).toBe(true);
  });
});

describe('validateUpdate — status', () => {
  it.each([
    'official', 'Official', ' OFFICIAL', 'OFFICIAL ', 'FINAL', 'DNF', 'DQ', '',
    'PROVISIONAL,CONFIRMED', 'PROVISIONAL|OFFICIAL',
  ])('rejects "%s"', (s) => {
    expect(validateUpdate(withField('status', s)).ok).toBe(false);
  });
  it('rejects arrays of valid statuses', () => {
    expect(validateUpdate(withField('status', ['OFFICIAL'])).ok).toBe(false);
  });
  it('rejects prototype-ish values', () => {
    expect(validateUpdate(withField('status', 'toString')).ok).toBe(false);
    expect(validateUpdate(withField('status', 'constructor')).ok).toBe(false);
  });
});

describe('validateUpdate — reports every reason, for the dead-letter record', () => {
  it('lists all failing fields', () => {
    const r = validateUpdate({ eventId: '', bib: 'X', lane: 'a', revision: 0, status: 'nope', timeMs: -1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const fields = r.errors.map((e) => e.field).sort();
      expect(fields).toEqual(['eventId', 'lane', 'revision', 'status', 'timeMs']);
    }
  });
});
