import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { Types } from 'mongoose';
import { AlertModel, type AlertStatus } from '../../src/modules/alerts/alerts.model.js';
import { countActiveAlerts, createAlertsRepo } from '../../src/modules/alerts/alerts.service.js';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

const silentLogger = pino({ level: 'silent' });

/**
 * Tests de integración del conteo de alertas activas (spec alert-store: cap
 * de `ALERTS_MAX_ACTIVE`), insertando documentos directamente vía
 * `AlertModel` contra un Mongo en memoria real — todavía no existe una capa
 * HTTP para alertas (llega en una fase posterior).
 */

function alertInput(overrides: { userId: Types.ObjectId; status: AlertStatus }) {
  return {
    userId: overrides.userId,
    coinId: new Types.ObjectId(),
    type: 'PRICE_ABOVE' as const,
    threshold: 100,
    status: overrides.status,
  };
}

describe('alerts active cap (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
    await ensureCollections(silentLogger);
  }, 120000);

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  it('counts only armed/triggered alerts and excludes completed/disabled ones', async () => {
    const userId = new Types.ObjectId();
    const otherUserId = new Types.ObjectId();

    await AlertModel.create([
      alertInput({ userId, status: 'armed' }),
      alertInput({ userId, status: 'triggered' }),
      alertInput({ userId, status: 'completed' }),
      alertInput({ userId, status: 'disabled' }),
      // De otro usuario: nunca debe contar en el total de `userId`.
      alertInput({ userId: otherUserId, status: 'armed' }),
    ]);

    const count = await countActiveAlerts(userId.toString());
    expect(count).toBe(2);
  });

  it('frees up capacity when an active alert is disabled', async () => {
    const userId = new Types.ObjectId();
    const repo = createAlertsRepo();

    const alerts = await AlertModel.create([
      alertInput({ userId, status: 'armed' }),
      alertInput({ userId, status: 'armed' }),
      alertInput({ userId, status: 'triggered' }),
    ]);

    await expect(repo.countActiveAlerts(userId)).resolves.toBe(3);

    const [firstAlert] = alerts;
    if (!firstAlert) {
      throw new Error('expected AlertModel.create to return the inserted documents');
    }
    await AlertModel.updateOne({ _id: firstAlert._id }, { $set: { status: 'disabled' } });

    await expect(repo.countActiveAlerts(userId)).resolves.toBe(2);
  });

  it('returns 0 for a user with no alerts', async () => {
    const userId = new Types.ObjectId();
    await expect(countActiveAlerts(userId.toString())).resolves.toBe(0);
  });
});
