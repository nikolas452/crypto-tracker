import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import pino from 'pino';
import { createPollPricesJob, type CreatePollPricesJobDeps } from '../../src/jobs/pollPrices.js';
import type { EvaluateAlertsDeps } from '../../src/jobs/alertEvaluation.js';
import type { CoinsRepo, ActiveCoin } from '../../src/modules/coins/coins.service.js';
import type { SnapshotsRepo } from '../../src/modules/snapshots/snapshots.service.js';
import { createJobRunsRepo } from '../../src/modules/job-runs/job-runs.service.js';
import { AlertModel } from '../../src/modules/alerts/alerts.model.js';
import { NotificationModel } from '../../src/modules/notifications/notifications.model.js';
import { UserModel } from '../../src/modules/users/users.model.js';
import { ensureCollections } from '../../src/db/ensureCollections.js';
import { clearDatabase, startInMemoryMongo, stopInMemoryMongo } from '../helpers/mongoMemory.js';

const silentLogger = pino({ level: 'silent' });

/**
 * Tests de integración del paso de evaluación de alertas del job
 * `poll-prices` (spec alert-evaluation, tareas 6.11-6.13): corre el job
 * completo (`createPollPricesJob`) contra un Mongo en memoria real, con
 * `AlertModel`/`NotificationModel`/`UserModel` reales — las transacciones son
 * justamente lo que hay que probar, así que no tiene sentido fakearlas.
 * `coinsRepo`/`snapshotsRepo`/`coingecko` sí están fakeados, mismo patrón que
 * `tests/unit/pollPrices.test.ts`, porque no son el foco de este archivo.
 */

interface PollHarness {
  readonly job: ReturnType<typeof createPollPricesJob>;
  readonly coin: ActiveCoin;
  setPrice(priceUsd: number, change24hPct?: number | null): void;
  setNow(date: Date): void;
}

/**
 * Arma un job `poll-prices` completo con dependencias fakeadas para todo lo
 * que no sea la evaluación de alertas (coinsRepo/snapshotsRepo/coingecko) y
 * un reloj manualmente controlable, para poder simular el paso del tiempo
 * entre corridas (cooldown, rearme) de forma determinística.
 */
function createHarness(overrides: {
  coin?: Partial<ActiveCoin>;
  alertEvaluationDeps?: EvaluateAlertsDeps;
  extraDeps?: Partial<CreatePollPricesJobDeps>;
} = {}): PollHarness {
  const coin: ActiveCoin = {
    id: new Types.ObjectId(),
    coingeckoId: 'bitcoin',
    name: 'Bitcoin',
    symbol: 'btc',
    ...overrides.coin,
  };

  let priceUsd = 0;
  let change24hPct: number | null = null;
  let now = new Date('2026-01-01T00:00:00.000Z');
  let sourceUpdatedCounter = 0;

  const coinsRepo: CoinsRepo = {
    async findActive() {
      return [coin];
    },
    async upsertFromMarket() {
      throw new Error('not used in these tests');
    },
    async refreshLatest(updates) {
      return { matchedCount: updates.length, modifiedCount: updates.length };
    },
  };

  const snapshotsRepo: SnapshotsRepo = {
    // Siempre "cambiado" (Map vacío -> lastSourceUpdatedAt null): cada
    // corrida inserta un snapshot nuevo, así docsToInsert nunca queda vacío.
    async getLastSourceUpdatedAt() {
      return new Map();
    },
    async insertMany(docs) {
      return docs.length;
    },
  };

  const jobRunsRepo = createJobRunsRepo();

  const getSimplePrices = async () => {
    sourceUpdatedCounter += 1;
    return {
      prices: new Map([
        [
          coin.coingeckoId,
          {
            priceUsd,
            marketCapUsd: null,
            volume24hUsd: null,
            change24hPct,
            sourceUpdatedAt: new Date(now.getTime() + sourceUpdatedCounter),
          },
        ],
      ]),
      attempts: 1,
    };
  };

  const job = createPollPricesJob({
    coinsRepo,
    snapshotsRepo,
    jobRunsRepo,
    coingecko: { getSimplePrices },
    clock: { now: () => now },
    logger: silentLogger,
    workerId: 'alert-eval-test',
    alertEvaluationDeps: overrides.alertEvaluationDeps,
    ...overrides.extraDeps,
  });

  return {
    job,
    coin,
    setPrice(p, c = null) {
      priceUsd = p;
      change24hPct = c;
    },
    setNow(d) {
      now = d;
    },
  };
}

async function seedUser(overrides: { emailVerified?: boolean; email?: string } = {}) {
  const user = await UserModel.create({
    firebaseUid: new Types.ObjectId().toString(),
    email: overrides.email ?? 'user@example.com',
    emailVerified: overrides.emailVerified ?? true,
    lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  return user;
}

async function seedAlert(input: {
  userId: Types.ObjectId;
  coinId: Types.ObjectId;
  threshold: number;
  cooldownMinutes?: number;
  rearmPct?: number;
  mode?: 'once' | 'recurring';
}) {
  const alert = await AlertModel.create({
    userId: input.userId,
    coinId: input.coinId,
    type: 'PRICE_BELOW',
    threshold: input.threshold,
    cooldownMinutes: input.cooldownMinutes ?? 60,
    rearmPct: input.rearmPct ?? 1,
    mode: input.mode ?? 'recurring',
    status: 'armed',
  });
  return alert;
}

describe('alert-evaluation (integration)', () => {
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

  // E5-2, E5-3, E5-4, E5-5: ciclo de vida completo de una misma alerta
  // PRICE_BELOW a través de varias corridas del job, controlando el reloj y
  // el precio entre cada una.
  it('E5-2..E5-5: trigger -> stays triggered -> rearm -> cooldown -> retrigger, across successive runs', async () => {
    const user = await seedUser();
    const harness = createHarness();
    const alert = await seedAlert({
      userId: user._id,
      coinId: harness.coin.id,
      threshold: 50000,
      cooldownMinutes: 60,
      rearmPct: 1,
    });

    const t0 = new Date('2026-01-01T00:00:00.000Z');

    // E5-2: precio 49000 <= 50000 -> dispara. triggerCount pasa a 1, un
    // único notification pending con dedupeKey terminado en ":1".
    harness.setNow(t0);
    harness.setPrice(49000);
    const run1 = await harness.job.run('manual');

    expect(run1.status).toBe('success');
    expect(run1.stats.alertsTriggered).toBe(1);

    const afterTrigger = await AlertModel.findById(alert._id).orFail();
    expect(afterTrigger.status).toBe('triggered');
    expect(afterTrigger.triggerCount).toBe(1);

    const notificationsAfterTrigger = await NotificationModel.find({ alertId: alert._id });
    expect(notificationsAfterTrigger).toHaveLength(1);
    expect(notificationsAfterTrigger[0]?.dedupeKey).toBe(`${alert._id.toString()}:1`);
    expect(notificationsAfterTrigger[0]?.status).toBe('pending');

    // E5-3: todavía triggered, precio 49500 sigue sin cumplir la condición
    // de rearme (49500 < 50000 * 1.01 = 50500) -> NOOP, sin nueva notificación.
    harness.setNow(new Date(t0.getTime() + 5 * 60 * 1000));
    harness.setPrice(49500);
    const run2 = await harness.job.run('manual');

    expect(run2.stats.alertsTriggered).toBe(0);
    expect(run2.stats.alertsRearmed).toBe(0);
    const afterSecondRun = await AlertModel.findById(alert._id).orFail();
    expect(afterSecondRun.status).toBe('triggered');
    await expect(NotificationModel.countDocuments({ alertId: alert._id })).resolves.toBe(1);

    // E5-4 (primera mitad): precio 50400, todavía por debajo del umbral de
    // rearme (50500) -> sigue triggered.
    harness.setNow(new Date(t0.getTime() + 10 * 60 * 1000));
    harness.setPrice(50400);
    await harness.job.run('manual');
    const stillTriggered = await AlertModel.findById(alert._id).orFail();
    expect(stillTriggered.status).toBe('triggered');

    // E5-4 (segunda mitad): precio 50600 > 50500 -> rearma a `armed`.
    harness.setNow(new Date(t0.getTime() + 15 * 60 * 1000));
    harness.setPrice(50600);
    const run4 = await harness.job.run('manual');

    expect(run4.stats.alertsRearmed).toBe(1);
    const rearmed = await AlertModel.findById(alert._id).orFail();
    expect(rearmed.status).toBe('armed');
    // El rearme nunca toca lastTriggeredAt (solo status/lastEvaluatedAt/version).
    expect(rearmed.lastTriggeredAt?.getTime()).toBe(t0.getTime());

    // E5-5 (primera mitad): condición de disparo vuelve a cumplirse (49000),
    // pero todavía estamos a solo 20 minutos de lastTriggeredAt (t0) con
    // cooldownMinutes: 60 -> COOLDOWN, sin escritura ni nueva notificación.
    harness.setNow(new Date(t0.getTime() + 20 * 60 * 1000));
    harness.setPrice(49000);
    const run5 = await harness.job.run('manual');

    expect(run5.stats.alertsInCooldown).toBe(1);
    expect(run5.stats.alertsTriggered).toBe(0);
    const stillArmedInCooldown = await AlertModel.findById(alert._id).orFail();
    expect(stillArmedInCooldown.status).toBe('armed');
    await expect(NotificationModel.countDocuments({ alertId: alert._id })).resolves.toBe(1);

    // E5-5 (segunda mitad): 61 minutos después de lastTriggeredAt (t0) ->
    // fuera de cooldown -> dispara de nuevo. triggerCount pasa a 2, segunda
    // notificación con dedupeKey terminado en ":2".
    harness.setNow(new Date(t0.getTime() + 61 * 60 * 1000));
    harness.setPrice(49000);
    const run6 = await harness.job.run('manual');

    expect(run6.stats.alertsTriggered).toBe(1);
    const retriggered = await AlertModel.findById(alert._id).orFail();
    expect(retriggered.status).toBe('triggered');
    expect(retriggered.triggerCount).toBe(2);

    const allNotifications = await NotificationModel.find({ alertId: alert._id }).sort({
      createdAt: 1,
    });
    expect(allNotifications).toHaveLength(2);
    expect(allNotifications[1]?.dedupeKey).toBe(`${alert._id.toString()}:2`);
  });

  // E5-7 (task 6.12): conflicto de versión optimista. Un `onBeforeTriggerWrite`
  // inyectado (solo-test, ver alertEvaluation.ts) bumpea `version` desde
  // AFUERA de la transacción justo antes del `findOneAndUpdate` del TRIGGER,
  // simulando de forma determinística que otro writer cambió la alerta en la
  // ventana entre la lectura del cursor y esta escritura — el mismo efecto
  // que produciría una carrera real, pero reproducible en un test.
  it('E5-7: a concurrent version bump makes the optimistic write miss; alert unchanged, triggerConflicts counted', async () => {
    const user = await seedUser();
    let bumped = false;
    const alertEvaluationDeps: EvaluateAlertsDeps = {
      async onBeforeTriggerWrite(alert) {
        if (!bumped) {
          bumped = true;
          await AlertModel.updateOne({ _id: alert._id }, { $inc: { version: 1 } }).exec();
        }
      },
    };
    const harness = createHarness({ alertEvaluationDeps });
    const alert = await seedAlert({
      userId: user._id,
      coinId: harness.coin.id,
      threshold: 50000,
    });

    harness.setPrice(49000);
    const result = await harness.job.run('manual');

    expect(result.stats.triggerConflicts).toBe(1);
    expect(result.stats.alertsTriggered).toBe(0);

    const unchanged = await AlertModel.findById(alert._id).orFail();
    // El writer externo sí aplicó su $inc de version (1); lo que nunca pasó
    // es el flip de status ni el resto de los campos del TRIGGER.
    expect(unchanged.version).toBe(1);
    expect(unchanged.status).toBe('armed');
    expect(unchanged.triggerCount).toBe(0);
    expect(unchanged.lastTriggeredAt).toBeNull();

    await expect(NotificationModel.countDocuments({ alertId: alert._id })).resolves.toBe(0);
  });

  // E5-8 (task 6.13): el insert de la notificación falla por una razón que
  // NO es clave duplicada (inyectada vía `insertNotification`, el mecanismo
  // de deps recomendado por la spec para este caso). Debe hacer rollback de
  // la transacción completa, incluido el flip de la alerta.
  it('E5-8: a non-duplicate notification insert failure rolls back the whole transaction', async () => {
    const user = await seedUser();
    const alertEvaluationDeps: EvaluateAlertsDeps = {
      async insertNotification() {
        throw new Error('simulated non-duplicate insert failure');
      },
    };
    const harness = createHarness({ alertEvaluationDeps });
    const alert = await seedAlert({
      userId: user._id,
      coinId: harness.coin.id,
      threshold: 50000,
    });

    harness.setPrice(49000);
    const result = await harness.job.run('manual');

    // La corrida entera se degrada a `partial` con ALERT_EVALUATION_FAILED
    // (spec alert-evaluation: "Failure degradation"), preservando lo demás.
    expect(result.status).toBe('partial');
    expect(result.error?.code).toBe('ALERT_EVALUATION_FAILED');

    const unchanged = await AlertModel.findById(alert._id).orFail();
    expect(unchanged.status).toBe('armed');
    expect(unchanged.version).toBe(0);
    expect(unchanged.triggerCount).toBe(0);
    expect(unchanged.lastTriggeredAt).toBeNull();

    await expect(NotificationModel.countDocuments({ alertId: alert._id })).resolves.toBe(0);
  });

  // Idempotencia del dedupeKey: un insert que colisiona con una notificación
  // ya existente (mismo alertId + triggerCount) aborta ESTE intento entero
  // (flip incluido) en lugar de commitear con una segunda fila duplicada.
  //
  // OJO — esto difiere de la redacción literal de la spec ("let the
  // transaction commit"): se comprobó empíricamente (script aislado contra
  // `MongoMemoryReplSet`) que un E11000 dentro de una transacción
  // multi-documento la deja en un estado no-committeable — atrapar el error
  // y devolver normalmente hace que `session.withTransaction()` reintente el
  // callback COMPLETO para siempre (loop infinito real, no solo lento) en
  // vez de commitear. Ver el comentario de `DuplicateNotificationSentinel`
  // en `alertEvaluation.ts`. Abortar es la única forma de terminar en un
  // intento sin colgar el job; la alerta queda tal como estaba antes.
  it('a duplicate dedupeKey on the notification insert aborts this attempt without hanging or duplicating', async () => {
    const user = await seedUser();
    const harness = createHarness();
    const alert = await seedAlert({
      userId: user._id,
      coinId: harness.coin.id,
      threshold: 50000,
    });

    // Pre-siembra la notificación que el propio job insertaría (mismo
    // dedupeKey que produciría triggerCount pasando de 0 a 1).
    await NotificationModel.create({
      userId: user._id,
      alertId: alert._id,
      channel: 'email',
      to: 'user@example.com',
      status: 'pending',
      dedupeKey: `${alert._id.toString()}:1`,
      payload: {
        coingeckoId: harness.coin.coingeckoId,
        coinName: harness.coin.name,
        symbol: harness.coin.symbol,
        alertType: 'PRICE_BELOW',
        threshold: 50000,
        value: 49000,
        priceUsd: 49000,
        change24hPct: null,
        triggeredAt: new Date('2026-01-01T00:00:00.000Z'),
        note: null,
      },
      attempts: 0,
      maxAttempts: 5,
      nextAttemptAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    harness.setPrice(49000);
    const result = await harness.job.run('manual');

    // El intento entero abortó: ni un fallo de la corrida (sigue siendo
    // `success`) ni un TRIGGER contado — nada se comprometió esta vez.
    expect(result.status).toBe('success');
    expect(result.stats.alertsTriggered).toBe(0);
    expect(result.stats.triggerConflicts).toBe(0);

    // La alerta queda exactamente como estaba antes del intento (rollback
    // completo, flip incluido).
    const unchanged = await AlertModel.findById(alert._id).orFail();
    expect(unchanged.status).toBe('armed');
    expect(unchanged.triggerCount).toBe(0);

    // Sigue habiendo una única notificación (la pre-sembrada) — el insert
    // duplicado no produjo una segunda fila.
    await expect(NotificationModel.countDocuments({ alertId: alert._id })).resolves.toBe(1);
  });

  // Evaluación acotada a las monedas con snapshot nuevo esta corrida (spec
  // alert-evaluation, scope de entrada): una alerta de una moneda que NO
  // recibió snapshot esta corrida nunca se evalúa.
  it('never evaluates alerts of a coin outside this run\'s fresh snapshots', async () => {
    const user = await seedUser();
    const harness = createHarness();
    const otherCoinId = new Types.ObjectId();
    const alert = await seedAlert({
      userId: user._id,
      coinId: otherCoinId,
      threshold: 50000,
    });

    harness.setPrice(49000);
    const result = await harness.job.run('manual');

    expect(result.stats.alertsEvaluated).toBe(0);
    const unchanged = await AlertModel.findById(alert._id).orFail();
    expect(unchanged.status).toBe('armed');
  });

  // E5-6 (spec alert-store / alert-evaluation): una alerta `mode: 'once'`
  // pasa a `completed` al dispararse y no vuelve a evaluarse hasta que el
  // usuario la rehabilite — deferred desde la tarea 5.9 porque necesitaba el
  // job de evaluación real (fase 6), no la API sola.
  it("E5-6: a mode:'once' alert completes on trigger and is never evaluated again", async () => {
    const user = await seedUser();
    const harness = createHarness();
    const alert = await seedAlert({
      userId: user._id,
      coinId: harness.coin.id,
      threshold: 50000,
      mode: 'once',
    });

    harness.setPrice(49000);
    const firstRun = await harness.job.run('manual');

    expect(firstRun.stats.alertsTriggered).toBe(1);
    const triggered = await AlertModel.findById(alert._id).orFail();
    expect(triggered.status).toBe('completed');
    expect(triggered.triggerCount).toBe(1);

    // Otra corrida, con el precio todavía por debajo del threshold: si
    // `completed` se evaluara de nuevo, dispararía otra vez (triggerCount 2,
    // una segunda notificación). No debe pasar nada.
    const secondRun = await harness.job.run('manual');

    expect(secondRun.stats.alertsEvaluated).toBe(0);
    const stillCompleted = await AlertModel.findById(alert._id).orFail();
    expect(stillCompleted.status).toBe('completed');
    expect(stillCompleted.triggerCount).toBe(1);

    const notifications = await NotificationModel.find({ alertId: alert._id }).exec();
    expect(notifications).toHaveLength(1);
  });
});
