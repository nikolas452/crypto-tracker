import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { logger } from '../../src/lib/logger.js';
import type { VerifiedIdentity } from '../../src/integrations/firebase/tokenVerifier.js';
import {
  resolveFromIdentity,
  type UserLean,
  type UsersRepo,
} from '../../src/modules/users/users.service.js';

/**
 * Tests unitarios de `resolveFromIdentity` (`src/modules/users/users.service.ts`):
 * el aprovisionamiento just-in-time, el reintento ante `E11000`, y la
 * decisión de sincronización de campos/`lastSeenAt` con reloj fijo (spec
 * user-profile, E3-6/E3-7). Usa un `UsersRepo` falso en memoria — nunca toca
 * Mongo real, a diferencia del test de integración E3-5.
 */

const THROTTLE_CFG = { LAST_SEEN_THROTTLE_MIN: 5 };

function makeIdentity(overrides: Partial<VerifiedIdentity> = {}): VerifiedIdentity {
  return {
    uid: 'firebase-uid-1',
    email: 'nicolas@example.com',
    emailVerified: true,
    name: 'Nicolas',
    ...overrides,
  };
}

function makeUserLean(overrides: Partial<UserLean> = {}): UserLean {
  const now = new Date('2024-01-01T00:00:00.000Z');
  return {
    _id: new Types.ObjectId(),
    firebaseUid: 'firebase-uid-1',
    email: 'nicolas@example.com',
    emailVerified: true,
    displayName: null,
    role: 'user',
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface FakeRepoOptions {
  readonly existing?: UserLean | null;
  readonly insertResult?: UserLean;
  readonly insertError?: unknown;
  readonly winnerAfterRace?: UserLean | null;
  readonly updateResult?: UserLean | null;
}

function createFakeRepo(options: FakeRepoOptions = {}): UsersRepo & {
  findByFirebaseUid: ReturnType<typeof vi.fn>;
  insertOnFirstSight: ReturnType<typeof vi.fn>;
  updateSyncedFields: ReturnType<typeof vi.fn>;
} {
  let findCallCount = 0;

  const findByFirebaseUid = vi.fn(async () => {
    findCallCount += 1;
    // La primera llamada es el lookup inicial de `resolveFromIdentity`; una
    // eventual segunda llamada es el reintento tras un E11000.
    if (findCallCount === 1) {
      return options.existing ?? null;
    }
    return options.winnerAfterRace ?? null;
  });

  const insertOnFirstSight = vi.fn(async () => {
    if (options.insertError) {
      throw options.insertError;
    }
    return options.insertResult ?? makeUserLean();
  });

  const updateSyncedFields = vi.fn(async () => options.updateResult ?? null);

  return { findByFirebaseUid, insertOnFirstSight, updateSyncedFields };
}

describe('resolveFromIdentity — aprovisionamiento just-in-time', () => {
  it('creates a new user when the firebaseUid is unknown', async () => {
    const created = makeUserLean();
    const repo = createFakeRepo({ existing: null, insertResult: created });
    const now = new Date('2024-01-01T00:00:00.000Z');

    const result = await resolveFromIdentity(makeIdentity(), now, THROTTLE_CFG, repo);

    expect(repo.insertOnFirstSight).toHaveBeenCalledTimes(1);
    expect(result.id).toBe(created._id.toString());
    expect(result.role).toBe('user');
  });

  it('retries exactly once with findByFirebaseUid after a duplicate-key race (E11000)', async () => {
    const winner = makeUserLean();
    const duplicateKeyError = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    const repo = createFakeRepo({ existing: null, insertError: duplicateKeyError, winnerAfterRace: winner });

    const result = await resolveFromIdentity(makeIdentity(), new Date(), THROTTLE_CFG, repo);

    expect(repo.insertOnFirstSight).toHaveBeenCalledTimes(1);
    expect(repo.findByFirebaseUid).toHaveBeenCalledTimes(2);
    expect(result.id).toBe(winner._id.toString());
  });

  // 4.6 / RNF-3.2: el log de creación lleva el userId, nunca el email en claro.
  it('logs creation at info with the userId and a masked email, never the raw email', async () => {
    const created = makeUserLean();
    const repo = createFakeRepo({ existing: null, insertResult: created });
    const infoSpy = vi.spyOn(logger, 'info');

    await resolveFromIdentity(makeIdentity({ email: 'nicolas@example.com' }), new Date(), THROTTLE_CFG, repo);

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ userId: created._id.toString(), maskedEmail: 'n***@example.com' }),
      'User profile created',
    );
    const serializedCalls = JSON.stringify(infoSpy.mock.calls);
    expect(serializedCalls).not.toContain('nicolas@example.com');
    infoSpy.mockRestore();
  });

  it('rethrows a non-duplicate-key error from the insert without retrying', async () => {
    const otherError = new Error('connection reset');
    const repo = createFakeRepo({ existing: null, insertError: otherError });

    await expect(resolveFromIdentity(makeIdentity(), new Date(), THROTTLE_CFG, repo)).rejects.toBe(
      otherError,
    );
    expect(repo.findByFirebaseUid).toHaveBeenCalledTimes(1);
  });
});

describe('resolveFromIdentity — sincronización de un usuario existente', () => {
  // E3-6 (parte 1): lastSeenAt reciente, no se toca.
  it('leaves a recent lastSeenAt untouched (1 minute old, throttle 5 minutes)', async () => {
    const now = new Date('2024-01-01T00:05:00.000Z');
    const existing = makeUserLean({ lastSeenAt: new Date('2024-01-01T00:04:00.000Z') });
    const repo = createFakeRepo({ existing });

    const result = await resolveFromIdentity(makeIdentity(), now, THROTTLE_CFG, repo);

    expect(repo.updateSyncedFields).not.toHaveBeenCalled();
    expect(result.lastSeenAt).toEqual(existing.lastSeenAt);
  });

  // E3-6 (parte 2): lastSeenAt stale, se refresca.
  it('refreshes a stale lastSeenAt (10 minutes old, throttle 5 minutes)', async () => {
    const now = new Date('2024-01-01T00:10:00.000Z');
    const existing = makeUserLean({ lastSeenAt: new Date('2024-01-01T00:00:00.000Z') });
    const updated = makeUserLean({ lastSeenAt: now });
    const repo = createFakeRepo({ existing, updateResult: updated });

    await resolveFromIdentity(makeIdentity(), now, THROTTLE_CFG, repo);

    expect(repo.updateSyncedFields).toHaveBeenCalledTimes(1);
    expect(repo.updateSyncedFields).toHaveBeenCalledWith(existing.firebaseUid, { lastSeenAt: now });
  });

  // E3-7: emailVerified se sincroniza desde el token.
  it('synchronizes emailVerified when the token disagrees with the stored value', async () => {
    const now = new Date('2024-01-01T00:00:30.000Z'); // dentro del throttle
    const existing = makeUserLean({ emailVerified: false, lastSeenAt: now });
    const identity = makeIdentity({ emailVerified: true });
    const updated = makeUserLean({ emailVerified: true });
    const repo = createFakeRepo({ existing, updateResult: updated });

    const result = await resolveFromIdentity(identity, now, THROTTLE_CFG, repo);

    expect(repo.updateSyncedFields).toHaveBeenCalledTimes(1);
    expect(repo.updateSyncedFields).toHaveBeenCalledWith(existing.firebaseUid, {
      email: identity.email,
      emailVerified: true,
    });
    expect(result.emailVerified).toBe(true);
  });

  it('issues no write at all when email, emailVerified and lastSeenAt already match', async () => {
    const now = new Date('2024-01-01T00:00:30.000Z');
    const existing = makeUserLean({ lastSeenAt: now });
    const identity = makeIdentity({ email: existing.email, emailVerified: existing.emailVerified });
    const repo = createFakeRepo({ existing });

    const result = await resolveFromIdentity(identity, now, THROTTLE_CFG, repo);

    expect(repo.updateSyncedFields).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ email: existing.email, emailVerified: existing.emailVerified }),
    );
  });

  it('combines an email change and a stale lastSeenAt into a single updateOne', async () => {
    const now = new Date('2024-01-01T00:10:00.000Z');
    const existing = makeUserLean({
      email: 'old@example.com',
      lastSeenAt: new Date('2024-01-01T00:00:00.000Z'),
    });
    const identity = makeIdentity({ email: 'new@example.com', emailVerified: true });
    const repo = createFakeRepo({ existing, updateResult: makeUserLean() });

    await resolveFromIdentity(identity, now, THROTTLE_CFG, repo);

    expect(repo.updateSyncedFields).toHaveBeenCalledTimes(1);
    expect(repo.updateSyncedFields).toHaveBeenCalledWith(existing.firebaseUid, {
      email: 'new@example.com',
      emailVerified: true,
      lastSeenAt: now,
    });
  });

  it('stores a null email when the identity carries no email claim', async () => {
    const now = new Date('2024-01-01T00:00:30.000Z');
    const existing = makeUserLean({ lastSeenAt: now });
    const identity = makeIdentity({ email: null, emailVerified: false });
    const repo = createFakeRepo({ existing, updateResult: makeUserLean({ email: null, emailVerified: false }) });

    await resolveFromIdentity(identity, now, THROTTLE_CFG, repo);

    expect(repo.updateSyncedFields).toHaveBeenCalledWith(existing.firebaseUid, {
      email: null,
      emailVerified: false,
    });
  });
});
