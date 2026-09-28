import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { NotFoundError, UnprocessableError } from '../../src/lib/errors.js';
import { createAlertBodySchema } from '../../src/modules/alerts/alerts.schemas.js';
import {
  createAlert,
  type AlertRecord,
  type AlertsRepo,
} from '../../src/modules/alerts/alerts.service.js';
import type { CoinRef } from '../../src/modules/coins/coins.service.js';

/**
 * Tests unitarios del módulo de alertas (tarea 5.8):
 * - `createAlertBodySchema` (unión discriminada por `type`): el rango de
 *   `threshold` válido por cada uno de los tres tipos de alerta.
 * - `createAlert` (`src/modules/alerts/alerts.service.ts`): el orden fijo de
 *   validaciones de `POST /api/v1/me/alerts` (spec alert-api) — email no
 *   verificado corta antes de cualquier llamada a DB; moneda
 *   inexistente/inactiva corta antes del chequeo de cap; el cap se chequea
 *   al final, justo antes de insertar.
 * Usa un `AlertsRepo` falso en memoria y un `findCoin` falso — nunca toca
 * Mongo real, a diferencia de los tests de integración E5-*.
 */

describe('createAlertBodySchema — rango de threshold por tipo', () => {
  describe('PRICE_ABOVE', () => {
    it('accepts a threshold just above 0 and up to 1e9', () => {
      expect(
        createAlertBodySchema.safeParse({ coingeckoId: 'bitcoin', type: 'PRICE_ABOVE', threshold: 0.01 })
          .success,
      ).toBe(true);
      expect(
        createAlertBodySchema.safeParse({ coingeckoId: 'bitcoin', type: 'PRICE_ABOVE', threshold: 1e9 })
          .success,
      ).toBe(true);
    });

    it('rejects a threshold of 0 or below', () => {
      expect(
        createAlertBodySchema.safeParse({ coingeckoId: 'bitcoin', type: 'PRICE_ABOVE', threshold: 0 })
          .success,
      ).toBe(false);
      expect(
        createAlertBodySchema.safeParse({ coingeckoId: 'bitcoin', type: 'PRICE_ABOVE', threshold: -1 })
          .success,
      ).toBe(false);
    });

    it('rejects a threshold above 1e9', () => {
      expect(
        createAlertBodySchema.safeParse({
          coingeckoId: 'bitcoin',
          type: 'PRICE_ABOVE',
          threshold: 1e9 + 1,
        }).success,
      ).toBe(false);
    });
  });

  describe('PRICE_BELOW', () => {
    it('accepts the same range as PRICE_ABOVE (>0 and <=1e9)', () => {
      expect(
        createAlertBodySchema.safeParse({ coingeckoId: 'bitcoin', type: 'PRICE_BELOW', threshold: 100 })
          .success,
      ).toBe(true);
      expect(
        createAlertBodySchema.safeParse({ coingeckoId: 'bitcoin', type: 'PRICE_BELOW', threshold: 0 })
          .success,
      ).toBe(false);
    });
  });

  describe('CHANGE_24H_ABS_GTE', () => {
    it('accepts a threshold within 0.1-100 (inclusive boundaries)', () => {
      expect(
        createAlertBodySchema.safeParse({
          coingeckoId: 'bitcoin',
          type: 'CHANGE_24H_ABS_GTE',
          threshold: 0.1,
        }).success,
      ).toBe(true);
      expect(
        createAlertBodySchema.safeParse({
          coingeckoId: 'bitcoin',
          type: 'CHANGE_24H_ABS_GTE',
          threshold: 100,
        }).success,
      ).toBe(true);
    });

    it('rejects a threshold below 0.1', () => {
      expect(
        createAlertBodySchema.safeParse({
          coingeckoId: 'bitcoin',
          type: 'CHANGE_24H_ABS_GTE',
          threshold: 0.05,
        }).success,
      ).toBe(false);
    });

    it('rejects a threshold above 100', () => {
      expect(
        createAlertBodySchema.safeParse({
          coingeckoId: 'bitcoin',
          type: 'CHANGE_24H_ABS_GTE',
          threshold: 100.1,
        }).success,
      ).toBe(false);
    });

    it('rejects the price-range threshold 50000 — out of range for this type (proves branches are independent)', () => {
      expect(
        createAlertBodySchema.safeParse({
          coingeckoId: 'bitcoin',
          type: 'CHANGE_24H_ABS_GTE',
          threshold: 50000,
        }).success,
      ).toBe(false);
    });
  });

  it('rejects an unknown type', () => {
    expect(
      createAlertBodySchema.safeParse({ coingeckoId: 'bitcoin', type: 'NOT_A_TYPE', threshold: 100 })
        .success,
    ).toBe(false);
  });

  it('rejects a body with an extra unknown key (.strict())', () => {
    expect(
      createAlertBodySchema.safeParse({
        coingeckoId: 'bitcoin',
        type: 'PRICE_ABOVE',
        threshold: 100,
        extra: 'nope',
      }).success,
    ).toBe(false);
  });
});

function makeCoin(overrides: Partial<CoinRef> = {}): CoinRef {
  return {
    id: new Types.ObjectId(),
    coingeckoId: 'bitcoin',
    symbol: 'btc',
    name: 'Bitcoin',
    isActive: true,
    latest: null,
    ...overrides,
  };
}

function makeAlertRecord(overrides: Partial<AlertRecord> = {}): AlertRecord {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: new Types.ObjectId(),
    coinId: new Types.ObjectId(),
    type: 'PRICE_ABOVE',
    threshold: 50000,
    mode: 'recurring',
    status: 'armed',
    cooldownMinutes: 60,
    rearmPct: 1,
    note: null,
    version: 0,
    triggerCount: 0,
    lastTriggeredAt: null,
    lastTriggeredValue: null,
    lastEvaluatedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface FakeRepoOptions {
  readonly count?: number;
  readonly insertResult?: AlertRecord;
}

function createFakeRepo(options: FakeRepoOptions = {}): AlertsRepo & {
  countActiveAlerts: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
} {
  const countActiveAlerts = vi.fn(async () => options.count ?? 0);
  const insert = vi.fn(async () => options.insertResult ?? makeAlertRecord());

  return {
    countActiveAlerts,
    insert,
    findByIdAndUser: vi.fn(),
    updateByIdAndUser: vi.fn(),
    deleteByIdAndUser: vi.fn(),
    deleteAllByUser: vi.fn(),
    listByUser: vi.fn(),
  };
}

const USER_ID = new Types.ObjectId().toString();
const CREATE_BODY = {
  coingeckoId: 'bitcoin',
  type: 'PRICE_ABOVE' as const,
  threshold: 50000,
};

describe('createAlert — orden de validaciones (spec alert-api)', () => {
  it('rejects with 422 UNPROCESSABLE/EMAIL_NOT_VERIFIED before any DB call, when the email is not verified', async () => {
    const repo = createFakeRepo();
    const findCoin = vi.fn(async () => makeCoin());

    try {
      await createAlert(USER_ID, false, CREATE_BODY, { repo, findCoin });
      expect.unreachable('createAlert should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnprocessableError);
      expect((error as UnprocessableError).details).toEqual({ reason: 'EMAIL_NOT_VERIFIED' });
    }

    expect(findCoin).not.toHaveBeenCalled();
    expect(repo.countActiveAlerts).not.toHaveBeenCalled();
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('rejects with 404 NOT_FOUND when the coin does not exist, without checking the cap or inserting', async () => {
    const repo = createFakeRepo();
    const findCoin = vi.fn(async () => null);

    await expect(createAlert(USER_ID, true, CREATE_BODY, { repo, findCoin })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    expect(repo.countActiveAlerts).not.toHaveBeenCalled();
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('rejects with 404 NOT_FOUND when the coin exists but is inactive, without checking the cap or inserting', async () => {
    const repo = createFakeRepo();
    const findCoin = vi.fn(async () => makeCoin({ isActive: false }));

    await expect(createAlert(USER_ID, true, CREATE_BODY, { repo, findCoin })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    expect(repo.countActiveAlerts).not.toHaveBeenCalled();
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('rejects with 422 UNPROCESSABLE/LIMIT_REACHED when the active-alert cap is reached, without inserting', async () => {
    const repo = createFakeRepo({ count: 2 });
    const findCoin = vi.fn(async () => makeCoin());

    try {
      await createAlert(USER_ID, true, CREATE_BODY, {
        repo,
        findCoin,
        cfg: { ALERTS_MAX_ACTIVE: 2 },
      });
      expect.unreachable('createAlert should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnprocessableError);
      expect((error as UnprocessableError).details).toEqual({ reason: 'LIMIT_REACHED' });
    }

    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('checks the cap only after the coin lookup has already passed (fixed validation order)', async () => {
    const repo = createFakeRepo({ count: 999 });
    const findCoin = vi.fn(async () => null);

    await expect(
      createAlert(USER_ID, true, CREATE_BODY, { repo, findCoin, cfg: { ALERTS_MAX_ACTIVE: 1 } }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // Coin lookup failed first — the cap (which would also reject) never ran.
    expect(repo.countActiveAlerts).not.toHaveBeenCalled();
  });

  it('inserts with status armed and returns meta.conditionCurrentlyMet computed from latest, when every validation passes', async () => {
    const coin = makeCoin({
      latest: {
        priceUsd: 51000,
        marketCapUsd: null,
        volume24hUsd: null,
        change24hPct: 2.5,
        capturedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const record = makeAlertRecord({ coinId: coin.id, threshold: 50000 });
    const repo = createFakeRepo({ count: 0, insertResult: record });
    const findCoin = vi.fn(async () => coin);

    const result = await createAlert(USER_ID, true, CREATE_BODY, {
      repo,
      findCoin,
      cfg: { ALERTS_MAX_ACTIVE: 20 },
    });

    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ coinId: coin.id, type: 'PRICE_ABOVE', threshold: 50000 }),
    );
    expect(result.meta).toEqual({ currentValue: 51000, conditionCurrentlyMet: true });
    expect(result.data).toMatchObject({ coingeckoId: 'bitcoin', status: 'armed' });
  });

  it('reports conditionCurrentlyMet: false and currentValue: null when the coin has no latest snapshot yet', async () => {
    const coin = makeCoin({ latest: null });
    const record = makeAlertRecord({ coinId: coin.id });
    const repo = createFakeRepo({ count: 0, insertResult: record });
    const findCoin = vi.fn(async () => coin);

    const result = await createAlert(USER_ID, true, CREATE_BODY, { repo, findCoin });

    expect(result.meta).toEqual({ currentValue: null, conditionCurrentlyMet: false });
  });
});
