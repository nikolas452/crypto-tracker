/**
 * Tabla de casos de los tests de contrato OpenAPI: cada fila describe una
 * llamada a una operación documentada (método, ruta en formato OpenAPI,
 * parámetros, autenticación, cuerpo y status esperado). Hay al menos un caso de
 * éxito por operación (más variantes y errores de negocio documentados). El
 * orden importa: los casos comparten los datos sembrados y los destructivos
 * (borrados, deshabilitar jobs) van después de los que leen lo que destruyen.
 */
import type { Response } from 'supertest';
import { expect } from 'vitest';
import type { AppKind, AuthKind, ContractContext } from './openapiContractSeed.js';

/** Valor fijo o derivado del contexto sembrado (los ids reales existen recién tras sembrar). */
export type Lazy<T> = T | ((ctx: ContractContext) => T);

export interface OperationCase {
  readonly name: string;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Ruta en formato OpenAPI, tal como figura en el documento. */
  readonly path: string;
  readonly status: number;
  readonly auth?: AuthKind;
  readonly app?: AppKind;
  readonly params?: Readonly<Record<string, Lazy<string>>>;
  readonly query?: Lazy<Readonly<Record<string, string>>>;
  readonly body?: Lazy<unknown>;
  /** Comprobaciones extra de negocio sobre la respuesta, además de la validación contra el contrato. */
  readonly check?: (response: Response, ctx: ContractContext) => void;
}

const ALERT_ID = (ctx: ContractContext): string => ctx.ids.alertId;
const ago = (ctx: ContractContext, minutes: number): string =>
  new Date(ctx.nowMs - minutes * 60_000).toISOString();
const now = (ctx: ContractContext): string => new Date(ctx.nowMs).toISOString();

export const CONTRACT_CASES: readonly OperationCase[] = [
  // --- Públicas ---
  { name: 'health: liveness', method: 'GET', path: '/health', status: 200 },
  { name: 'health: readiness', method: 'GET', path: '/health/ready', status: 200 },
  {
    name: 'health: readiness with the database down',
    method: 'GET',
    path: '/health/ready',
    status: 503,
    app: 'dbDown',
    check: (response) => {
      expect(response.body.checks.mongo).toBe('down');
    },
  },
  { name: 'status', method: 'GET', path: '/api/v1/status', status: 200 },
  {
    name: 'coins: list',
    method: 'GET',
    path: '/api/v1/coins',
    status: 200,
    check: (response) => {
      expect(response.body.data.map((coin: { coingeckoId: string }) => coin.coingeckoId)).toEqual(
        expect.arrayContaining(['bitcoin', 'ethereum']),
      );
    },
  },
  {
    name: 'coins: list with search, sort and pagination',
    method: 'GET',
    path: '/api/v1/coins',
    status: 200,
    query: { q: 'bit', sort: 'name', order: 'asc', page: '1', limit: '5' },
  },
  {
    name: 'coins: detail with a latest price',
    method: 'GET',
    path: '/api/v1/coins/{coingeckoId}',
    status: 200,
    params: { coingeckoId: 'bitcoin' },
  },
  {
    name: 'coins: detail without a latest price',
    method: 'GET',
    path: '/api/v1/coins/{coingeckoId}',
    status: 200,
    params: { coingeckoId: 'ethereum' },
    check: (response) => {
      expect(response.body.data.latest).toBeNull();
    },
  },
  {
    name: 'coins: history with the default window',
    method: 'GET',
    path: '/api/v1/coins/{coingeckoId}/history',
    status: 200,
    params: { coingeckoId: 'bitcoin' },
    check: (response) => {
      expect(response.body.data.interval).toBe('1h');
      expect(response.body.data.points.length).toBeGreaterThan(0);
    },
  },
  {
    name: 'coins: raw history',
    method: 'GET',
    path: '/api/v1/coins/{coingeckoId}/history',
    status: 200,
    params: { coingeckoId: 'bitcoin' },
    query: (ctx) => ({ interval: 'raw', from: ago(ctx, 180), to: now(ctx) }),
    check: (response) => {
      expect(response.body.data.interval).toBe('raw');
      expect(response.body.data.points).toHaveLength(5);
    },
  },
  {
    name: 'coins: hourly history with a moving average',
    method: 'GET',
    path: '/api/v1/coins/{coingeckoId}/history',
    status: 200,
    params: { coingeckoId: 'bitcoin' },
    query: (ctx) => ({ interval: '1h', sma: '2', from: ago(ctx, 360), to: now(ctx) }),
    check: (response) => {
      const points = response.body.data.points as Array<{ sma: number | null }>;
      expect(points.length).toBeGreaterThan(1);
      expect(points[0]?.sma).toBeNull();
    },
  },
  {
    name: 'coins: stats with the default range',
    method: 'GET',
    path: '/api/v1/coins/{coingeckoId}/stats',
    status: 200,
    params: { coingeckoId: 'bitcoin' },
    check: (response) => {
      expect(response.body.data.samples).toBe(5);
    },
  },
  {
    name: 'coins: stats for a 7 day range',
    method: 'GET',
    path: '/api/v1/coins/{coingeckoId}/stats',
    status: 200,
    params: { coingeckoId: 'bitcoin' },
    query: { range: '7d' },
  },
  {
    name: 'coins: stats with no data in the window',
    method: 'GET',
    path: '/api/v1/coins/{coingeckoId}/stats',
    status: 200,
    params: { coingeckoId: 'ethereum' },
    check: (response) => {
      expect(response.body.data.samples).toBe(0);
      expect(response.body.data.open).toBeNull();
    },
  },
  { name: 'openapi: document', method: 'GET', path: '/api/v1/openapi.json', status: 200 },

  // --- Usuario autenticado ---
  { name: 'me: get profile', method: 'GET', path: '/api/v1/me', status: 200, auth: 'user' },
  {
    name: 'me: update display name',
    method: 'PATCH',
    path: '/api/v1/me',
    status: 200,
    auth: 'user',
    body: { displayName: 'Contract User' },
  },
  {
    name: 'watchlist: list',
    method: 'GET',
    path: '/api/v1/me/watchlist',
    status: 200,
    auth: 'user',
    check: (response) => {
      expect(response.body.meta).toEqual({ count: 2, max: 50 });
    },
  },
  {
    name: 'watchlist: list sorted by name',
    method: 'GET',
    path: '/api/v1/me/watchlist',
    status: 200,
    auth: 'user',
    query: { sort: 'name', order: 'asc' },
  },
  {
    name: 'watchlist: add a coin (201 with Location)',
    method: 'POST',
    path: '/api/v1/me/watchlist',
    status: 201,
    auth: 'user',
    body: { coingeckoId: 'solana', note: 'probar' },
    check: (response) => {
      expect(response.headers['location']).toBe('/api/v1/me/watchlist/solana');
    },
  },
  {
    name: 'watchlist: add an unknown coin',
    method: 'POST',
    path: '/api/v1/me/watchlist',
    status: 404,
    auth: 'user',
    body: { coingeckoId: 'does-not-exist' },
  },
  {
    name: 'watchlist: add a coin that is already followed',
    method: 'POST',
    path: '/api/v1/me/watchlist',
    status: 409,
    auth: 'user',
    body: { coingeckoId: 'bitcoin' },
  },
  {
    name: 'watchlist: add a coin past the limit',
    method: 'POST',
    path: '/api/v1/me/watchlist',
    status: 422,
    auth: 'user',
    app: 'tinyLimits',
    body: { coingeckoId: 'ethereum' },
    check: (response) => {
      expect(response.body.error.details).toEqual({ reason: 'LIMIT_REACHED' });
    },
  },
  {
    name: 'watchlist: update a note',
    method: 'PATCH',
    path: '/api/v1/me/watchlist/{coingeckoId}',
    status: 200,
    auth: 'user',
    params: { coingeckoId: 'bitcoin' },
    body: { note: 'nueva nota' },
  },
  {
    name: 'watchlist: clear a note',
    method: 'PATCH',
    path: '/api/v1/me/watchlist/{coingeckoId}',
    status: 200,
    auth: 'user',
    params: { coingeckoId: 'bitcoin' },
    body: { note: null },
  },
  {
    name: 'watchlist: update a note of a coin that is not followed',
    method: 'PATCH',
    path: '/api/v1/me/watchlist/{coingeckoId}',
    status: 404,
    auth: 'user',
    params: { coingeckoId: 'ethereum' },
    body: { note: 'nota' },
  },
  {
    name: 'watchlist: remove a coin',
    method: 'DELETE',
    path: '/api/v1/me/watchlist/{coingeckoId}',
    status: 204,
    auth: 'user',
    params: { coingeckoId: 'solana' },
  },
  {
    name: 'alerts: list',
    method: 'GET',
    path: '/api/v1/me/alerts',
    status: 200,
    auth: 'user',
    check: (response) => {
      expect(response.body.meta.total).toBe(4);
    },
  },
  {
    name: 'alerts: list filtered by status and coin',
    method: 'GET',
    path: '/api/v1/me/alerts',
    status: 200,
    auth: 'user',
    query: { status: 'armed,triggered', coingeckoId: 'bitcoin' },
    check: (response) => {
      expect(response.body.data).toHaveLength(2);
    },
  },
  {
    name: 'alerts: create PRICE_ABOVE (201 with Location)',
    method: 'POST',
    path: '/api/v1/me/alerts',
    status: 201,
    auth: 'user',
    body: { type: 'PRICE_ABOVE', coingeckoId: 'bitcoin', threshold: 70000, mode: 'once' },
    check: (response) => {
      expect(response.headers['location']).toBe(`/api/v1/me/alerts/${response.body.data.id}`);
      expect(response.body.meta.conditionCurrentlyMet).toBe(false);
    },
  },
  {
    name: 'alerts: create PRICE_BELOW',
    method: 'POST',
    path: '/api/v1/me/alerts',
    status: 201,
    auth: 'user',
    body: { type: 'PRICE_BELOW', coingeckoId: 'bitcoin', threshold: 70000, cooldownMinutes: 120 },
    check: (response) => {
      expect(response.body.meta.conditionCurrentlyMet).toBe(true);
    },
  },
  {
    name: 'alerts: create CHANGE_24H_ABS_GTE on a coin without a price',
    method: 'POST',
    path: '/api/v1/me/alerts',
    status: 201,
    auth: 'user',
    body: {
      type: 'CHANGE_24H_ABS_GTE',
      coingeckoId: 'ethereum',
      threshold: 5,
      rearmPct: 2,
      note: 'movimiento fuerte',
    },
    check: (response) => {
      expect(response.body.meta.currentValue).toBeNull();
    },
  },
  {
    name: 'alerts: create for an unknown coin',
    method: 'POST',
    path: '/api/v1/me/alerts',
    status: 404,
    auth: 'user',
    body: { type: 'PRICE_ABOVE', coingeckoId: 'does-not-exist', threshold: 10 },
  },
  {
    name: 'alerts: create with an unverified email',
    method: 'POST',
    path: '/api/v1/me/alerts',
    status: 422,
    auth: 'unverified',
    body: { type: 'PRICE_ABOVE', coingeckoId: 'bitcoin', threshold: 70000 },
    check: (response) => {
      expect(response.body.error.details).toEqual({ reason: 'EMAIL_NOT_VERIFIED' });
    },
  },
  {
    name: 'alerts: create past the active limit',
    method: 'POST',
    path: '/api/v1/me/alerts',
    status: 422,
    auth: 'user',
    app: 'tinyLimits',
    body: { type: 'PRICE_ABOVE', coingeckoId: 'bitcoin', threshold: 70000 },
    check: (response) => {
      expect(response.body.error.details).toEqual({ reason: 'LIMIT_REACHED' });
    },
  },
  {
    name: 'alerts: get one',
    method: 'GET',
    path: '/api/v1/me/alerts/{id}',
    status: 200,
    auth: 'user',
    params: { id: ALERT_ID },
  },
  {
    name: 'alerts: get an unknown one',
    method: 'GET',
    path: '/api/v1/me/alerts/{id}',
    status: 404,
    auth: 'user',
    params: { id: (ctx) => ctx.ids.missingId },
  },
  {
    name: 'alerts: update the threshold',
    method: 'PATCH',
    path: '/api/v1/me/alerts/{id}',
    status: 200,
    auth: 'user',
    params: { id: ALERT_ID },
    body: { threshold: 72000 },
  },
  {
    name: 'alerts: disable',
    method: 'PATCH',
    path: '/api/v1/me/alerts/{id}',
    status: 200,
    auth: 'user',
    params: { id: ALERT_ID },
    body: { enabled: false },
    check: (response) => {
      expect(response.body.data.status).toBe('disabled');
    },
  },
  {
    name: 'alerts: re-arm past the active limit',
    method: 'PATCH',
    path: '/api/v1/me/alerts/{id}',
    status: 422,
    auth: 'user',
    app: 'tinyLimits',
    params: { id: (ctx) => ctx.ids.completedAlertId },
    body: { enabled: true },
    check: (response) => {
      expect(response.body.error.details).toEqual({ reason: 'LIMIT_REACHED' });
    },
  },
  {
    name: 'alerts: delete',
    method: 'DELETE',
    path: '/api/v1/me/alerts/{id}',
    status: 204,
    auth: 'user',
    params: { id: (ctx) => ctx.ids.alertToDeleteId },
  },
  {
    name: 'notifications: list',
    method: 'GET',
    path: '/api/v1/me/notifications',
    status: 200,
    auth: 'user',
    check: (response) => {
      expect(response.body.meta.total).toBe(2);
    },
  },
  {
    name: 'notifications: list filtered by status',
    method: 'GET',
    path: '/api/v1/me/notifications',
    status: 200,
    auth: 'user',
    query: { status: 'failed' },
    check: (response) => {
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].lastError).toEqual({ code: 'SMTP_UNAVAILABLE' });
    },
  },
  // Cuenta descartable: borrar el perfil del usuario principal rompería los casos siguientes.
  {
    name: 'me: delete account',
    method: 'DELETE',
    path: '/api/v1/me',
    status: 204,
    auth: 'throwaway',
  },

  // --- Administración ---
  {
    name: 'admin coins: list',
    method: 'GET',
    path: '/api/v1/admin/coins',
    status: 200,
    auth: 'admin',
    check: (response) => {
      expect(response.body.data).toHaveLength(4);
    },
  },
  {
    name: 'admin coins: list inactive coins',
    method: 'GET',
    path: '/api/v1/admin/coins',
    status: 200,
    auth: 'admin',
    query: { isActive: 'false', limit: '10' },
    check: (response) => {
      expect(response.body.data).toHaveLength(1);
    },
  },
  {
    name: 'admin coins: create (201)',
    method: 'POST',
    path: '/api/v1/admin/coins',
    status: 201,
    auth: 'admin',
    body: { coingeckoId: 'cardano' },
  },
  {
    name: 'admin coins: reactivate (200)',
    method: 'POST',
    path: '/api/v1/admin/coins',
    status: 200,
    auth: 'admin',
    body: { coingeckoId: 'dogecoin' },
    check: (response) => {
      expect(response.body.data.isActive).toBe(true);
    },
  },
  {
    name: 'admin coins: create a coin that is already active',
    method: 'POST',
    path: '/api/v1/admin/coins',
    status: 409,
    auth: 'admin',
    body: { coingeckoId: 'bitcoin' },
  },
  {
    name: 'admin coins: create with an id CoinGecko does not know',
    method: 'POST',
    path: '/api/v1/admin/coins',
    status: 422,
    auth: 'admin',
    body: { coingeckoId: 'not-a-real-coin' },
    check: (response) => {
      expect(response.body.error.details).toEqual({ reason: 'UNKNOWN_COINGECKO_ID' });
    },
  },
  {
    name: 'admin coins: create while CoinGecko is down',
    method: 'POST',
    path: '/api/v1/admin/coins',
    status: 502,
    auth: 'admin',
    body: { coingeckoId: 'upstream-down' },
    check: (response) => {
      expect(response.body.error.code).toBe('UPSTREAM_ERROR');
    },
  },
  {
    name: 'admin coins: deactivate',
    method: 'PATCH',
    path: '/api/v1/admin/coins/{coingeckoId}',
    status: 200,
    auth: 'admin',
    params: { coingeckoId: 'cardano' },
    body: { isActive: false },
    check: (response) => {
      expect(response.body.data.isActive).toBe(false);
    },
  },
  {
    name: 'admin coins: update an unknown coin',
    method: 'PATCH',
    path: '/api/v1/admin/coins/{coingeckoId}',
    status: 404,
    auth: 'admin',
    params: { coingeckoId: 'does-not-exist' },
    body: { isActive: true },
  },
  {
    name: 'job runs: list',
    method: 'GET',
    path: '/api/v1/admin/job-runs',
    status: 200,
    auth: 'admin',
    check: (response) => {
      expect(response.body.meta.total).toBe(4);
    },
  },
  {
    name: 'job runs: list filtered by status and job',
    method: 'GET',
    path: '/api/v1/admin/job-runs',
    status: 200,
    auth: 'admin',
    query: { status: 'failed,skipped', jobName: 'poll-prices' },
    check: (response) => {
      expect(response.body.data).toHaveLength(1);
    },
  },
  {
    name: 'job runs: get one',
    method: 'GET',
    path: '/api/v1/admin/job-runs/{id}',
    status: 200,
    auth: 'admin',
    params: { id: (ctx) => ctx.ids.jobRunId },
  },
  {
    name: 'job runs: get an unknown one',
    method: 'GET',
    path: '/api/v1/admin/job-runs/{id}',
    status: 404,
    auth: 'admin',
    params: { id: (ctx) => ctx.ids.missingId },
  },
  {
    name: 'jobs: list recurring jobs',
    method: 'GET',
    path: '/api/v1/admin/jobs',
    status: 200,
    auth: 'admin',
    check: (response) => {
      expect(response.body.data.recurring).toHaveLength(3);
      expect(response.body.data.oneOff).toBeUndefined();
    },
  },
  {
    name: 'jobs: trigger a job (202)',
    method: 'POST',
    path: '/api/v1/admin/jobs/{name}/run',
    status: 202,
    auth: 'admin',
    params: { name: 'poll-prices' },
  },
  {
    name: 'jobs: list including one-off jobs',
    method: 'GET',
    path: '/api/v1/admin/jobs',
    status: 200,
    auth: 'admin',
    query: { includeOneOff: 'true' },
    check: (response) => {
      expect(response.body.data.oneOff).toHaveLength(1);
    },
  },
  {
    name: 'jobs: trigger the same job again within 30 seconds',
    method: 'POST',
    path: '/api/v1/admin/jobs/{name}/run',
    status: 429,
    auth: 'admin',
    params: { name: 'poll-prices' },
  },
  {
    name: 'jobs: trigger an unknown job',
    method: 'POST',
    path: '/api/v1/admin/jobs/{name}/run',
    status: 404,
    auth: 'admin',
    params: { name: 'not-a-real-job' },
  },
  {
    name: 'jobs: disable a job',
    method: 'POST',
    path: '/api/v1/admin/jobs/{name}/disable',
    status: 200,
    auth: 'admin',
    params: { name: 'poll-prices' },
    check: (response) => {
      expect(response.body.data).toEqual({ name: 'poll-prices', disabled: true });
    },
  },
  {
    name: 'jobs: trigger a disabled job',
    method: 'POST',
    path: '/api/v1/admin/jobs/{name}/run',
    status: 409,
    auth: 'admin',
    params: { name: 'poll-prices' },
  },
  {
    name: 'jobs: enable a job',
    method: 'POST',
    path: '/api/v1/admin/jobs/{name}/enable',
    status: 200,
    auth: 'admin',
    params: { name: 'poll-prices' },
    check: (response) => {
      expect(response.body.data).toEqual({ name: 'poll-prices', disabled: false });
    },
  },
  {
    name: 'admin notifications: list',
    method: 'GET',
    path: '/api/v1/admin/notifications',
    status: 200,
    auth: 'admin',
    check: (response) => {
      expect(response.body.meta.total).toBe(2);
    },
  },
  {
    name: 'admin notifications: retry a failed notification',
    method: 'POST',
    path: '/api/v1/admin/notifications/{id}/retry',
    status: 200,
    auth: 'admin',
    params: { id: (ctx) => ctx.ids.failedNotificationId },
    check: (response) => {
      expect(response.body.data).toMatchObject({ status: 'pending', attempts: 0, lastError: null });
    },
  },
  {
    name: 'admin notifications: retry a notification that is no longer failed',
    method: 'POST',
    path: '/api/v1/admin/notifications/{id}/retry',
    status: 409,
    auth: 'admin',
    params: { id: (ctx) => ctx.ids.failedNotificationId },
  },
  {
    name: 'admin notifications: retry an unknown notification',
    method: 'POST',
    path: '/api/v1/admin/notifications/{id}/retry',
    status: 404,
    auth: 'admin',
    params: { id: (ctx) => ctx.ids.missingId },
  },
  {
    name: 'admin notifications: send a test email',
    method: 'POST',
    path: '/api/v1/admin/notifications/test-email',
    status: 200,
    auth: 'admin',
  },
  {
    name: 'admin notifications: test email without an email on file',
    method: 'POST',
    path: '/api/v1/admin/notifications/test-email',
    status: 422,
    auth: 'adminNoEmail',
    check: (response) => {
      expect(response.body.error.details).toEqual({ reason: 'NO_EMAIL_ON_FILE' });
    },
  },
  {
    name: 'admin notifications: test email while SMTP is down',
    method: 'POST',
    path: '/api/v1/admin/notifications/test-email',
    status: 502,
    auth: 'admin',
    app: 'smtpDown',
    check: (response) => {
      expect(response.body.error.details).toEqual({ reason: 'SMTP_UNAVAILABLE' });
    },
  },
];
