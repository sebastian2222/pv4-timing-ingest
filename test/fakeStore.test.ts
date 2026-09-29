import { describe, expect, it } from 'vitest';
import { FakeStore } from '../src/fakeStore';
import { RetryableStoreError } from '../src/store';
import type { TimingUpdate } from '../src/validate';

function upd(over: Partial<TimingUpdate> = {}): TimingUpdate {
  return {
    eventId: 'E1',
    bib: 'AUS-1147',
    lane: 3,
    revision: 1,
    status: 'PROVISIONAL',
    timeMs: 10105,
    ...over,
  };
}

describe('FakeStore', () => {
  it('creates a new athlete and refuses a second create for the same bib', async () => {
    const fake = new FakeStore();
    expect(await fake.createAthlete(upd(), 'a')).toEqual({ kind: 'COMMITTED' });
    expect(await fake.createAthlete(upd({ revision: 2 }), 'b')).toEqual({ kind: 'RETRY', reason: 'CONDITION_FAILED' });
    expect(fake.snapshot().eventStats('E1')).toEqual({
      eventId: 'E1', athletesTracked: 1, updatesAccepted: 1, updatesIgnored: 0,
    });
    expect(fake.snapshot().results('E1')).toEqual([
      { bib: 'AUS-1147', lane: 3, revision: 1, status: 'PROVISIONAL', timeMs: 10105 },
    ]);
  });

  it('does not advance a revision that is not greater, and writes nothing', async () => {
    const fake = new FakeStore();
    await fake.createAthlete(upd({ revision: 3, status: 'OFFICIAL' }), 'a');
    const before = fake.snapshot().eventStats('E1');
    expect(await fake.advanceAthlete(upd({ revision: 2, status: 'CONFIRMED' }), 'b')).toEqual({
      kind: 'RETRY', reason: 'CONDITION_FAILED',
    });
    expect(await fake.advanceAthlete(upd({ revision: 3, status: 'CONFIRMED' }), 'c')).toEqual({
      kind: 'RETRY', reason: 'CONDITION_FAILED',
    });
    expect(fake.snapshot().eventStats('E1')).toEqual(before);
    expect(fake.snapshot().results('E1')[0].status).toBe('OFFICIAL');
    // The failed requestId was not recorded, so a later update can use it.
    expect((await fake.advanceAthlete(upd({ revision: 4, status: 'PROVISIONAL' }), 'b')).kind).toBe('COMMITTED');
  });

  it('returns the first outcome when the same requestId is used twice, and does not count again', async () => {
    const fake = new FakeStore();
    expect(await fake.createAthlete(upd(), 'req')).toEqual({ kind: 'COMMITTED' });
    expect(await fake.advanceAthlete(upd({ revision: 9, status: 'OFFICIAL' }), 'req')).toEqual({
      kind: 'ALREADY_PROCESSED', outcome: 'ACCEPTED',
    });
    expect(fake.snapshot().eventStats('E1').updatesAccepted).toBe(1);
    expect(fake.snapshot().results('E1')[0].revision).toBe(1);
  });

  it('LOST_RESPONSE commits the write and then throws', async () => {
    const fake = new FakeStore();
    fake.injectNext('LOST_RESPONSE');
    await expect(fake.createAthlete(upd(), 'r')).rejects.toBeInstanceOf(RetryableStoreError);
    expect(fake.snapshot().results('E1')).toHaveLength(1);
    expect(fake.snapshot().eventStats('E1').updatesAccepted).toBe(1);
    expect(await fake.createAthlete(upd({ revision: 2 }), 'r')).toEqual({
      kind: 'ALREADY_PROCESSED', outcome: 'ACCEPTED',
    });
    expect(fake.snapshot().eventStats('E1').updatesAccepted).toBe(1);
    expect(fake.snapshot().eventStats('E1').updatesIgnored).toBe(0);
  });

  it('a failed transaction writes nothing at all', async () => {
    const fake = new FakeStore();
    await fake.createAthlete(upd(), 'a');
    fake.injectNext('CONFLICT');
    expect(await fake.advanceAthlete(upd({ revision: 2, status: 'OFFICIAL' }), 'b')).toEqual({
      kind: 'RETRY', reason: 'CONFLICT',
    });
    expect(fake.snapshot().results('E1')[0].revision).toBe(1);
    expect(fake.snapshot().eventStats('E1')).toEqual({
      eventId: 'E1', athletesTracked: 1, updatesAccepted: 1, updatesIgnored: 0,
    });
    expect(fake.snapshot().events).toEqual(['E1']);
  });

  it('TRANSIENT throws and leaves state unchanged', async () => {
    const fake = new FakeStore();
    fake.injectNext('TRANSIENT');
    await expect(fake.createAthlete(upd(), 'r')).rejects.toBeInstanceOf(RetryableStoreError);
    expect(fake.snapshot().events).toEqual([]);
    expect(fake.snapshot().updatesRejected).toBe(0);
  });

  it('records an ignore only while the stored revision is still not newer', async () => {
    const fake = new FakeStore();
    await fake.createAthlete(upd({ revision: 3, status: 'OFFICIAL' }), 'a');
    expect(await fake.recordIgnored(upd({ revision: 2, status: 'CONFIRMED' }), 'b')).toEqual({ kind: 'COMMITTED' });
    expect(fake.snapshot().eventStats('E1').updatesIgnored).toBe(1);
    expect(fake.snapshot().results('E1')[0].revision).toBe(3);
    expect(await fake.recordIgnored(upd({ revision: 4 }), 'c')).toEqual({ kind: 'RETRY', reason: 'CONDITION_FAILED' });
    expect(fake.snapshot().eventStats('E1').updatesIgnored).toBe(1);
  });

  it('counts a rejection once per requestId', async () => {
    const fake = new FakeStore();
    expect(await fake.recordRejected('r')).toEqual({ kind: 'COMMITTED' });
    expect(await fake.recordRejected('r')).toEqual({ kind: 'ALREADY_PROCESSED', outcome: 'REJECTED' });
    expect(fake.snapshot().updatesRejected).toBe(1);
    expect(fake.snapshot().events).toEqual([]);
  });
});
