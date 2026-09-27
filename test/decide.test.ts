import { describe, it, expect } from 'vitest';
import { decide } from '../src/decide';

describe('decide — the ordering rule, isolated', () => {
  it('applies when nothing is stored (new athlete)', () => {
    expect(decide(undefined, 1)).toBe('APPLY');
    expect(decide(undefined, 7)).toBe('APPLY'); // first-seen need not be revision 1
  });
  it('applies a strictly higher revision', () => {
    expect(decide(3, 4)).toBe('APPLY');
    expect(decide(1, 99)).toBe('APPLY');
  });
  it('ignores an equal revision (duplicate, or same revision with a different status)', () => {
    expect(decide(3, 3)).toBe('IGNORE');
  });
  it('ignores a lower revision (late, stale copy)', () => {
    expect(decide(3, 2)).toBe('IGNORE');
  });
  it('takes no status argument at all — status cannot influence the decision', () => {
    expect(decide.length).toBe(2);
  });
});
