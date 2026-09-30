import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { computeIndexDiffs, runDbSetup } from '../../src/scripts/dbSetup.js';
import { CoinModel } from '../../src/modules/coins/coins.model.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

const silentLogger = pino({ level: 'silent' });

/**
 * Tests de integración de `db:setup` (spec db-setup-script, deploy-render
 * tarea 5.5): `--dry-run` no toca nada, y una corrida normal crea un índice
 * faltante y es un no-op al repetirse.
 */
describe('db:setup (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 120000);

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  it('creates every declared index the first time it runs', async () => {
    await CoinModel.collection.dropIndexes().catch(() => undefined);

    await runDbSetup({ dryRun: false, logger: silentLogger }, [CoinModel]);

    const indexes = await CoinModel.collection.indexes();
    const hasIsActiveIndex = indexes.some(
      (index) => index.key.isActive === 1 && Object.keys(index.key).length === 1,
    );
    expect(hasIsActiveIndex).toBe(true);
  });

  it('reports no pending changes and modifies nothing on a second run', async () => {
    await runDbSetup({ dryRun: false, logger: silentLogger }, [CoinModel]);

    const diffsBefore = await computeIndexDiffs([CoinModel]);
    expect(diffsBefore[0]?.toCreate).toEqual([]);
    expect(diffsBefore[0]?.toDrop).toEqual([]);

    await runDbSetup({ dryRun: false, logger: silentLogger }, [CoinModel]);

    const diffsAfter = await computeIndexDiffs([CoinModel]);
    expect(diffsAfter[0]?.toCreate).toEqual([]);
    expect(diffsAfter[0]?.toDrop).toEqual([]);
  });

  it('--dry-run leaves the database untouched', async () => {
    await CoinModel.collection.dropIndexes().catch(() => undefined);

    const diffBefore = await computeIndexDiffs([CoinModel]);
    expect(diffBefore[0]?.toCreate.length).toBeGreaterThan(0);

    await runDbSetup({ dryRun: true, logger: silentLogger }, [CoinModel]);

    const indexesAfterDryRun = await CoinModel.collection.indexes();
    // Solo el índice implícito de `_id` sigue ahí — nada del schema se creó.
    expect(indexesAfterDryRun).toHaveLength(1);

    const diffAfter = await computeIndexDiffs([CoinModel]);
    expect(diffAfter[0]?.toCreate).toEqual(diffBefore[0]?.toCreate);
  });

  it('logs the index diff before applying anything', async () => {
    await CoinModel.collection.dropIndexes().catch(() => undefined);

    const infoSpy = vi.fn();
    const loggerSpy = { ...silentLogger, info: infoSpy } as unknown as typeof silentLogger;

    await runDbSetup({ dryRun: false, logger: loggerSpy }, [CoinModel]);

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'Coin' }),
      'db:setup: pending index changes',
    );
  });
});
