import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { acquire, JobLockModel, release, renew } from '../../src/lib/lease-lock.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

/**
 * Tests de integración del lease lock de `src/lib/lease-lock.ts` (spec
 * lease-lock) contra un MongoDB real en memoria: acquire libre/tomado/
 * vencido/re-adquirido por el mismo owner, y release de un lock ajeno como
 * no-op.
 */

describe('lease-lock (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 120000);

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  it('acquires a free resource', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');

    const result = await acquire('poll-prices', 'worker-a', 300000, now);

    expect(result).toBe(true);
    const doc = await JobLockModel.findById('poll-prices').lean().exec();
    expect(doc?.lockedBy).toBe('worker-a');
    expect(doc?.lockedUntil.getTime()).toBe(now.getTime() + 300000);
  });

  it('refuses a resource held by another owner and not expired', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    await acquire('poll-prices', 'worker-a', 300000, now);

    const later = new Date(now.getTime() + 1000);
    const result = await acquire('poll-prices', 'worker-b', 300000, later);

    expect(result).toBe(false);
    const doc = await JobLockModel.findById('poll-prices').lean().exec();
    expect(doc?.lockedBy).toBe('worker-a');
  });

  it('takes over a lease that already expired', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    await acquire('poll-prices', 'worker-a', 1000, now);

    const afterExpiry = new Date(now.getTime() + 5000);
    const result = await acquire('poll-prices', 'worker-b', 300000, afterExpiry);

    expect(result).toBe(true);
    const doc = await JobLockModel.findById('poll-prices').lean().exec();
    expect(doc?.lockedBy).toBe('worker-b');
  });

  it('lets the current owner re-acquire and extend the expiry', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    await acquire('poll-prices', 'worker-a', 300000, now);

    const later = new Date(now.getTime() + 1000);
    const result = await acquire('poll-prices', 'worker-a', 300000, later);

    expect(result).toBe(true);
    const doc = await JobLockModel.findById('poll-prices').lean().exec();
    expect(doc?.lockedUntil.getTime()).toBe(later.getTime() + 300000);
  });

  it('renews as the current owner', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    await acquire('poll-prices', 'worker-a', 300000, now);

    const later = new Date(now.getTime() + 1000);
    const result = await renew('poll-prices', 'worker-a', 300000, later);

    expect(result).toBe(true);
    const doc = await JobLockModel.findById('poll-prices').lean().exec();
    expect(doc?.lockedUntil.getTime()).toBe(later.getTime() + 300000);
  });

  it('does not renew a lease owned by someone else', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    await acquire('poll-prices', 'worker-a', 300000, now);

    const result = await renew('poll-prices', 'worker-b', 300000, now);

    expect(result).toBe(false);
  });

  it('does nothing when releasing another owner\'s lock', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    await acquire('poll-prices', 'worker-a', 300000, now);

    await release('poll-prices', 'worker-b');

    const doc = await JobLockModel.findById('poll-prices').lean().exec();
    expect(doc?.lockedBy).toBe('worker-a');
  });

  it('releases the caller\'s own lock', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    await acquire('poll-prices', 'worker-a', 300000, now);

    await release('poll-prices', 'worker-a');

    const doc = await JobLockModel.findById('poll-prices').lean().exec();
    expect(doc).toBeNull();
  });
});
