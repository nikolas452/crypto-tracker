/**
 * Tests de contrato de la especificación OpenAPI (spec openapi-contract-tests):
 * construyen el documento en memoria desde las anotaciones (`buildOpenapiDocument`,
 * con `failOnErrors`; nunca desde un archivo commiteado, así que no puede estar
 * desactualizado), levantan la app real con `createApp`, un verificador de
 * tokens falso, un CoinGecko y un mailer falsos y un MongoDB en memoria, llaman
 * a cada operación documentada y validan status, cuerpo y headers contra el
 * documento. También comprueban en ambos sentidos que cada ruta servida esté
 * documentada y viceversa, ejercitan las restricciones de petición que el
 * validador de respuestas no ve (límites, `sma`, `range`, claves desconocidas)
 * y demuestran, sobre copias mutadas del documento, que estas comprobaciones
 * detectan la deriva. Son herméticos: no hay red, Firebase ni CoinGecko reales.
 */
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import pino from 'pino';
import request, { type Response } from 'supertest';
import swaggerJsdoc from 'swagger-jsdoc';
import { createApp } from '../../src/app.js';
import { createFakeTokenVerifier } from '../../src/integrations/firebase/fakeTokenVerifier.js';
import { buildOpenapiDocument } from '../../src/docs/buildOpenapiDocument.js';
import { openapiDefinition } from '../../src/docs/openapi.definition.js';
import {
  type CoverageGaps,
  type JsonObject,
  type OperationRef,
  dereferenceOperation,
  documentedOperations,
  expandPath,
  findCoverageGaps,
  formatCoverageGaps,
  validateAgainstSchemaRef,
  validateResponse,
} from '../helpers/openapiContract.js';
import { CONTRACT_CASES, type Lazy, type OperationCase } from '../helpers/openapiContractCases.js';
import {
  type AuthKind,
  type ContractContext,
  TOKENS,
  createContractApp,
  startContractEnvironment,
  stopContractEnvironment,
} from '../helpers/openapiContractSeed.js';
import { type RouteEntry, listRoutes } from '../helpers/listRoutes.js';

const silentLogger = pino({ level: 'silent' });

// Se construye al cargar el archivo (en lugar de en `beforeAll`) para poder
// generar un test por operación documentada. Lanza si hay YAML malformado o
// `$ref` sin resolver.
const doc = await buildOpenapiDocument();

let ctx: ContractContext;
let fetchSpy: MockInstance<typeof fetch>;

beforeAll(async () => {
  // Si algún cliente real de red (CoinGecko, Firebase) se usara por error,
  // pasaría por `fetch`: el último test comprueba que nunca se llamó.
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  ctx = await startContractEnvironment(doc);
}, 120000);

afterAll(async () => {
  fetchSpy.mockRestore();
  await stopContractEnvironment();
});

// --- Utilidades de los tests ---

type Method = OperationCase['method'];

function resolve<T>(value: Lazy<T>): T {
  return typeof value === 'function' ? (value as (c: ContractContext) => T)(ctx) : value;
}

interface CallOptions {
  readonly app?: Express;
  readonly auth?: AuthKind;
  readonly token?: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/** Hace una petición a la app principal (o a la indicada) y devuelve la respuesta de supertest. */
async function call(method: Method, url: string, options: CallOptions = {}): Promise<Response> {
  const agent = request(options.app ?? ctx.apps.main);
  const builder =
    method === 'GET'
      ? agent.get(url)
      : method === 'POST'
        ? agent.post(url)
        : method === 'PATCH'
          ? agent.patch(url)
          : agent.delete(url);

  const token = options.token ?? (options.auth ? TOKENS[options.auth] : undefined);
  if (token) {
    builder.set('Authorization', `Bearer ${token}`);
  }
  if (options.query) {
    builder.query(options.query);
  }
  if (options.body !== undefined) {
    builder.send(options.body as object);
  }
  return builder;
}

/** Cuerpo parseado, o `undefined` si la respuesta no trae cuerpo (204, 304). */
function bodyOf(response: Response): unknown {
  return response.text === undefined || response.text === '' ? undefined : response.body;
}

/** Comprueba que la respuesta cumple lo que `operation` documenta para su status. */
function expectDocumented(response: Response, operation: OperationRef): void {
  const result = validateResponse(
    doc,
    operation,
    response.status,
    bodyOf(response),
    response.headers,
  );
  expect(result.errors).toEqual([]);
}

function operationNode(target: object, operation: OperationRef): JsonObject {
  const node = dereferenceOperation(target, operation);
  if (!node) {
    throw new Error(`Operación no documentada: ${operation.method} ${operation.path}`);
  }
  return node;
}

function authFor(operation: OperationRef): AuthKind | undefined {
  if (operation.path.startsWith('/api/v1/admin/')) return 'admin';
  if (operation.path.startsWith('/api/v1/me')) return 'user';
  return undefined;
}

/** Ids válidos en formato para rellenar parámetros de ruta cuando el valor no importa (la autenticación falla antes). */
function placeholderParams(path: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const match of path.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1]!;
    params[name] =
      name === 'coingeckoId' ? 'bitcoin' : name === 'name' ? 'poll-prices' : ctx.ids.missingId;
  }
  return params;
}

function queryParams(operation: OperationRef): JsonObject[] {
  const parameters = operationNode(doc, operation)['parameters'];
  return (Array.isArray(parameters) ? (parameters as JsonObject[]) : []).filter(
    (parameter) => parameter['in'] === 'query',
  );
}

// --- 7.1 Documento y entorno ---

describe('OpenAPI contract: document and environment', () => {
  it('builds the document in memory with every operation documented', () => {
    expect(doc.openapi).toBe('3.0.3');
    expect(documentedOperations(doc)).toHaveLength(33);
  });

  it('fails document generation on a malformed annotation (failOnErrors)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openapi-bad-annotation-'));
    try {
      const file = join(dir, 'bad.routes.ts');
      writeFileSync(
        file,
        ['/**', ' * @openapi', ' * /broken:', ' *   get: [unclosed', ' */'].join('\n'),
      );

      expect(() =>
        swaggerJsdoc({ failOnErrors: true, definition: openapiDefinition, apis: [file] }),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- 7.2 / 7.3 / 7.4 Casos de éxito (y errores de negocio documentados) por grupo ---

function groupOf(testCase: OperationCase): 'public' | 'user' | 'admin' {
  if (testCase.path.startsWith('/api/v1/admin/')) return 'admin';
  return testCase.auth === undefined ? 'public' : 'user';
}

async function runCase(testCase: OperationCase): Promise<void> {
  const params = Object.fromEntries(
    Object.entries(testCase.params ?? {}).map(([name, value]) => [name, resolve(value)]),
  );
  const response = await call(testCase.method, expandPath(testCase.path, params), {
    app: ctx.apps[testCase.app ?? 'main'],
    auth: testCase.auth,
    query: testCase.query === undefined ? undefined : resolve(testCase.query),
    body: testCase.body === undefined ? undefined : resolve(testCase.body),
  });

  expect(response.status, `${testCase.name}: ${response.text}`).toBe(testCase.status);
  expectDocumented(response, { method: testCase.method, path: testCase.path });
  testCase.check?.(response, ctx);
}

const GROUP_TITLES = {
  public: 'public operations',
  user: 'authenticated user operations',
  admin: 'admin operations',
} as const;

for (const group of ['public', 'user', 'admin'] as const) {
  describe(`OpenAPI contract: ${GROUP_TITLES[group]}`, () => {
    for (const testCase of CONTRACT_CASES.filter((candidate) => groupOf(candidate) === group)) {
      it(`${testCase.method} ${testCase.path} -> ${testCase.status}: ${testCase.name}`, async () => {
        await runCase(testCase);
      });
    }
  });
}

describe('OpenAPI contract: operation coverage of the case table', () => {
  it('has a success case for every documented operation', () => {
    const covered = new Set(
      CONTRACT_CASES.filter((testCase) => testCase.status >= 200 && testCase.status < 300).map(
        (testCase) => `${testCase.method} ${testCase.path}`,
      ),
    );
    const missing = documentedOperations(doc)
      .map((operation) => `${operation.method} ${operation.path}`)
      .filter((key) => !covered.has(key));

    expect(missing).toEqual([]);
  });

  it('exercises both 201 and 200 for POST /api/v1/admin/coins', () => {
    const statuses = CONTRACT_CASES.filter(
      (testCase) => testCase.method === 'POST' && testCase.path === '/api/v1/admin/coins',
    ).map((testCase) => testCase.status);

    expect(statuses).toEqual(expect.arrayContaining([201, 200]));
    const responses = operationNode(doc, { method: 'POST', path: '/api/v1/admin/coins' })[
      'responses'
    ];
    expect(Object.keys(responses as JsonObject)).toEqual(expect.arrayContaining(['200', '201']));
  });
});

describe('OpenAPI contract: conditional responses', () => {
  it('GET /api/v1/openapi.json answers 304 with its documented headers when the ETag matches', async () => {
    const operation = { method: 'GET', path: '/api/v1/openapi.json' };
    const first = await call('GET', '/api/v1/openapi.json');
    expect(first.status).toBe(200);
    expectDocumented(first, operation);

    const etag = first.headers['etag'];
    expect(etag).toBeDefined();

    const second = await request(ctx.apps.main)
      .get('/api/v1/openapi.json')
      .set('If-None-Match', etag ?? '');
    expect(second.status).toBe(304);
    expectDocumented(second, operation);
  });

  it('GET /api/v1/coins answers 304 with its documented headers when the ETag matches', async () => {
    const operation = { method: 'GET', path: '/api/v1/coins' };
    const first = await call('GET', '/api/v1/coins');
    const etag = first.headers['etag'];
    expect(etag).toBeDefined();

    const second = await request(ctx.apps.main)
      .get('/api/v1/coins')
      .set('If-None-Match', etag ?? '');
    expect(second.status).toBe(304);
    expectDocumented(second, operation);
  });
});

// --- 7.5 Envoltorio de error ---

const BEARER_OPERATIONS = documentedOperations(doc).filter((operation) => {
  const security = operationNode(doc, operation)['security'];
  return Array.isArray(security) && security.some((entry) => 'bearerAuth' in (entry as JsonObject));
});
const ADMIN_OPERATIONS = BEARER_OPERATIONS.filter((operation) =>
  operation.path.startsWith('/api/v1/admin/'),
);

describe('OpenAPI contract: error envelope', () => {
  describe('401 without a token', () => {
    it.each(
      BEARER_OPERATIONS.map(
        (operation) => [`${operation.method} ${operation.path}`, operation] as const,
      ),
    )('%s', async (_label, operation) => {
      const response = await call(
        operation.method as Method,
        expandPath(operation.path, placeholderParams(operation.path)),
      );

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
      expectDocumented(response, operation);
      expect(
        validateAgainstSchemaRef(doc, '#/components/schemas/Error', response.body).errors,
      ).toEqual([]);
      expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
    });

    it('rejects a token the verifier does not know with UNAUTHENTICATED', async () => {
      const response = await call('GET', '/api/v1/me', { token: 'not-a-known-token' });

      expect(response.status).toBe(401);
      expectDocumented(response, { method: 'GET', path: '/api/v1/me' });
    });
  });

  describe('403 as a non-admin user', () => {
    it.each(
      ADMIN_OPERATIONS.map(
        (operation) => [`${operation.method} ${operation.path}`, operation] as const,
      ),
    )('%s', async (_label, operation) => {
      const response = await call(
        operation.method as Method,
        expandPath(operation.path, placeholderParams(operation.path)),
        { auth: 'user' },
      );

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      expectDocumented(response, operation);
      expect(
        validateAgainstSchemaRef(doc, '#/components/schemas/Error', response.body).errors,
      ).toEqual([]);
    });
  });

  describe('404 for an unknown resource', () => {
    const notFoundCases: ReadonlyArray<
      readonly [string, Method, string, AuthKind | undefined, unknown]
    > = [
      ['coin detail', 'GET', '/api/v1/coins/{coingeckoId}', undefined, undefined],
      ['coin history', 'GET', '/api/v1/coins/{coingeckoId}/history', undefined, undefined],
      ['coin stats', 'GET', '/api/v1/coins/{coingeckoId}/stats', undefined, undefined],
      ['alert detail', 'GET', '/api/v1/me/alerts/{id}', 'user', undefined],
      [
        'watchlist item update',
        'PATCH',
        '/api/v1/me/watchlist/{coingeckoId}',
        'user',
        { note: 'x' },
      ],
      [
        'admin coin update',
        'PATCH',
        '/api/v1/admin/coins/{coingeckoId}',
        'admin',
        { isActive: true },
      ],
      ['job run detail', 'GET', '/api/v1/admin/job-runs/{id}', 'admin', undefined],
      ['job trigger', 'POST', '/api/v1/admin/jobs/{name}/run', 'admin', undefined],
      ['notification retry', 'POST', '/api/v1/admin/notifications/{id}/retry', 'admin', undefined],
    ];

    it.each(notFoundCases)('%s', async (_label, method, path, auth, body) => {
      const params = { coingeckoId: 'no-such-coin', id: ctx.ids.missingId, name: 'no-such-job' };
      const response = await call(method, expandPath(path, params), { auth, body });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expectDocumented(response, { method, path });
      expect(
        validateAgainstSchemaRef(doc, '#/components/schemas/Error', response.body).errors,
      ).toEqual([]);
    });

    it('answers a route that does not exist with the same Error envelope', async () => {
      const response = await call('GET', '/api/v1/no-such-route');

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(
        validateAgainstSchemaRef(doc, '#/components/schemas/Error', response.body).errors,
      ).toEqual([]);
    });
  });

  describe('400 validation failures', () => {
    const validationCases: ReadonlyArray<
      readonly [
        string,
        Method,
        string,
        AuthKind | undefined,
        Record<string, string>,
        unknown,
        string,
      ]
    > = [
      ['query', 'GET', '/api/v1/coins', undefined, { limit: '0' }, undefined, 'query.limit'],
      ['body', 'POST', '/api/v1/me/watchlist', 'user', {}, {}, 'body.coingeckoId'],
      ['params', 'GET', '/api/v1/me/alerts/{id}', 'user', {}, undefined, 'params.id'],
    ];

    it.each(validationCases)(
      'lists details with %s-prefixed paths',
      async (_origin, method, path, auth, query, body, expectedPath) => {
        const response = await call(method, expandPath(path, { id: 'not-an-object-id' }), {
          auth,
          query,
          body,
        });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');

        const details = response.body.error.details as Array<{ path: string; message: string }>;
        expect(Array.isArray(details)).toBe(true);
        for (const detail of details) {
          expect(typeof detail.message).toBe('string');
          expect(detail.path).toMatch(/^(body|query|params)(\.|$)/);
        }
        expect(details.map((detail) => detail.path)).toContain(expectedPath);

        expectDocumented(response, { method, path });
        expect(
          validateAgainstSchemaRef(doc, '#/components/schemas/Error', response.body).errors,
        ).toEqual([]);
      },
    );

    it('answers malformed JSON with VALIDATION_ERROR and no details', async () => {
      const response = await request(ctx.apps.main)
        .post('/api/v1/me/watchlist')
        .set('Authorization', `Bearer ${TOKENS.user}`)
        .set('Content-Type', 'application/json')
        .send('{"coingeckoId": ');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details).toBeUndefined();
      expectDocumented(response, { method: 'POST', path: '/api/v1/me/watchlist' });
    });
  });

  describe('other documented authentication and body failures', () => {
    const failingApp = (): Express =>
      createContractApp({
        tokenVerifier: createFakeTokenVerifier({
          identities: {
            'ok-token': { uid: 'u', email: 'u@example.com', emailVerified: true, name: null },
          },
          failures: {
            'expired-token': 'TOKEN_EXPIRED',
            'revoked-token': 'TOKEN_REVOKED',
            'disabled-token': 'USER_DISABLED',
            'firebase-down-token': 'FIREBASE_UNAVAILABLE',
          },
        }),
      });

    it.each([
      ['an expired token', 'GET', '/api/v1/me', 'expired-token', 401, 'TOKEN_EXPIRED'],
      [
        'a revoked token on account deletion',
        'DELETE',
        '/api/v1/me',
        'revoked-token',
        401,
        'TOKEN_REVOKED',
      ],
      ['a disabled account', 'GET', '/api/v1/me', 'disabled-token', 403, 'USER_DISABLED'],
      [
        'Firebase down on account deletion',
        'DELETE',
        '/api/v1/me',
        'firebase-down-token',
        502,
        'FIREBASE_UNAVAILABLE',
      ],
      [
        'Firebase down on an admin operation',
        'GET',
        '/api/v1/admin/coins',
        'firebase-down-token',
        502,
        'FIREBASE_UNAVAILABLE',
      ],
    ] as const)('%s', async (_label, method, path, token, status, code) => {
      const response = await call(method, path, { app: failingApp(), token });

      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(code);
      expectDocumented(response, { method, path });
      expect(
        validateAgainstSchemaRef(doc, '#/components/schemas/Error', response.body).errors,
      ).toEqual([]);
    });

    it('answers 413 for a body over the 100 KB limit', async () => {
      const response = await call('POST', '/api/v1/me/watchlist', {
        auth: 'user',
        body: { coingeckoId: 'bitcoin', note: 'x'.repeat(150_000) },
      });

      expect(response.status).toBe(413);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expectDocumented(response, { method: 'POST', path: '/api/v1/me/watchlist' });
    });
  });

  describe('429 rate limiting (shared RateLimited response)', () => {
    it('answers 429 from the per-IP limiter with Retry-After and the RateLimit-* headers', async () => {
      const app = createContractApp({
        rateLimitConfig: { RATE_LIMIT_MAX: 1, RATE_LIMIT_WINDOW_MIN: 15 },
      });
      const operation = { method: 'GET', path: '/api/v1/coins' };

      const first = await call('GET', '/api/v1/coins', { app });
      expect(first.status).toBe(200);

      const second = await call('GET', '/api/v1/coins', { app });
      expect(second.status).toBe(429);
      expect(second.body.error.code).toBe('RATE_LIMITED');
      expectDocumented(second, operation);
      expect(
        validateAgainstSchemaRef(doc, '#/components/schemas/Error', second.body).errors,
      ).toEqual([]);
    });

    it('answers 429 from the per-user limiter on an authenticated operation', async () => {
      const app = createContractApp({ userRateLimitConfig: { USER_RATE_LIMIT_PER_MIN: 1 } });
      const operation = { method: 'GET', path: '/api/v1/me' };

      const first = await call('GET', '/api/v1/me', { app, auth: 'user' });
      expect(first.status).toBe(200);

      const second = await call('GET', '/api/v1/me', { app, auth: 'user' });
      expect(second.status).toBe(429);
      expect(second.body.error.code).toBe('RATE_LIMITED');
      expectDocumented(second, operation);
    });
  });
});

// --- 7.6 Cobertura de rutas en ambos sentidos ---

const servedRoutes: RouteEntry[] = listRoutes(() => createApp({ logger: silentLogger }));

describe('OpenAPI contract: route coverage', () => {
  it('documents every served route and serves every documented operation', () => {
    const gaps = findCoverageGaps(doc, servedRoutes);

    // El mensaje lista método y ruta de cada ofensor.
    expect(formatCoverageGaps(gaps)).toBe('');
    expect(gaps.undocumented).toEqual([]);
    expect(gaps.orphaned).toEqual([]);
  });
});

// --- 7.7 Ejemplos límite de restricciones de petición ---

describe('OpenAPI contract: request constraints (boundary examples)', () => {
  describe('limit bounds', () => {
    it.each([
      ['0', 400],
      ['1', 200],
      ['100', 200],
      ['101', 400],
    ] as const)('GET /api/v1/coins?limit=%s -> %i', async (limit, status) => {
      const response = await call('GET', '/api/v1/coins', { query: { limit } });

      expect(response.status).toBe(status);
      expectDocumented(response, { method: 'GET', path: '/api/v1/coins' });
    });

    const paginated = documentedOperations(doc).filter((operation) =>
      queryParams(operation).some((parameter) => parameter['name'] === 'limit'),
    );

    it('is documented on every paginated list (6 operations)', () => {
      expect(paginated.map((operation) => operation.path).sort()).toEqual([
        '/api/v1/admin/coins',
        '/api/v1/admin/job-runs',
        '/api/v1/admin/notifications',
        '/api/v1/coins',
        '/api/v1/me/alerts',
        '/api/v1/me/notifications',
      ]);
    });

    it.each(paginated.map((operation) => [operation.path, operation] as const))(
      '%s enforces the documented minimum and maximum',
      async (_path, operation) => {
        const parameter = queryParams(operation).find((candidate) => candidate['name'] === 'limit');
        const schema = parameter?.['schema'] as { minimum: number; maximum: number };
        const auth = authFor(operation);

        for (const [limit, status] of [
          [schema.minimum - 1, 400],
          [schema.minimum, 200],
          [schema.maximum, 200],
          [schema.maximum + 1, 400],
        ] as const) {
          const response = await call('GET', operation.path, {
            auth,
            query: { limit: String(limit) },
          });
          expect(response.status, `limit=${limit}: ${response.text}`).toBe(status);
          expectDocumented(response, operation);
        }

        const page = await call('GET', operation.path, { auth, query: { page: '0' } });
        expect(page.status).toBe(400);
        expectDocumented(page, operation);
      },
    );
  });

  describe('history: interval and sma', () => {
    const history = '/api/v1/coins/bitcoin/history';
    const operation = { method: 'GET', path: '/api/v1/coins/{coingeckoId}/history' };
    const window = () => ({
      from: new Date(ctx.nowMs - 3_600_000).toISOString(),
      to: new Date(ctx.nowMs).toISOString(),
    });

    it('documents sma as an integer from 2 to 200', () => {
      const sma = queryParams(operation).find((parameter) => parameter['name'] === 'sma');
      expect(sma?.['schema']).toMatchObject({ type: 'integer', minimum: 2, maximum: 200 });
    });

    it('rejects sma together with interval=raw', async () => {
      const response = await call('GET', history, { query: { interval: 'raw', sma: '5' } });

      expect(response.status).toBe(400);
      expectDocumented(response, operation);
    });

    it('rejects sma when the interval is chosen automatically and resolves to raw', async () => {
      const response = await call('GET', history, { query: { ...window(), sma: '5' } });

      expect(response.status).toBe(400);
      expectDocumented(response, operation);
    });

    it.each([
      ['1', 400],
      ['2', 200],
      ['200', 200],
      ['201', 400],
    ] as const)('sma=%s with interval=1h -> %i', async (sma, status) => {
      const response = await call('GET', history, { query: { interval: '1h', sma } });

      expect(response.status).toBe(status);
      expectDocumented(response, operation);
    });

    it('rejects an interval outside raw, 1h and 1d', async () => {
      const response = await call('GET', history, { query: { interval: '5m' } });

      expect(response.status).toBe(400);
      expectDocumented(response, operation);
    });
  });

  describe('stats: range', () => {
    const stats = '/api/v1/coins/bitcoin/stats';
    const operation = { method: 'GET', path: '/api/v1/coins/{coingeckoId}/stats' };
    const range = queryParams(operation).find((parameter) => parameter['name'] === 'range');
    const documented = (range?.['schema'] as { enum: string[]; default: string }).enum;

    it('documents the four accepted ranges with 24h as the default', () => {
      expect(documented).toEqual(['24h', '7d', '30d', '90d']);
      expect((range?.['schema'] as { default: string }).default).toBe('24h');
    });

    it.each(documented)('accepts range=%s', async (value) => {
      const response = await call('GET', stats, { query: { range: value } });

      expect(response.status).toBe(200);
      expect(response.body.data.range).toBe(value);
      expectDocumented(response, operation);
    });

    it('applies the documented default when range is omitted', async () => {
      const response = await call('GET', stats);

      expect(response.status).toBe(200);
      expect(response.body.data.range).toBe('24h');
    });

    it('rejects a range that is not documented', async () => {
      const response = await call('GET', stats, { query: { range: '1y' } });

      expect(response.status).toBe(400);
      expectDocumented(response, operation);
    });
  });

  describe('unknown keys', () => {
    // Toda lectura que documenta parámetros de query rechaza las claves desconocidas con 400.
    const withQuery = documentedOperations(doc).filter(
      (operation) =>
        operation.method === 'GET' &&
        operation.path !== '/api/v1/openapi.json' &&
        queryParams(operation).length > 0,
    );

    it.each(withQuery.map((operation) => [operation.path, operation] as const))(
      'GET %s rejects an unknown query key',
      async (_path, operation) => {
        const response = await call(
          'GET',
          expandPath(operation.path, { coingeckoId: 'bitcoin', id: ctx.ids.missingId }),
          { auth: authFor(operation), query: { notARealKey: '1' } },
        );

        expect(response.status, response.text).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expectDocumented(response, operation);
      },
    );

    const unknownBodyCases: ReadonlyArray<readonly [Method, string, AuthKind, unknown]> = [
      ['POST', '/api/v1/me/watchlist', 'user', { coingeckoId: 'bitcoin', userId: 'someone-else' }],
      ['PATCH', '/api/v1/me/watchlist/{coingeckoId}', 'user', { note: 'x', extra: true }],
      ['PATCH', '/api/v1/me', 'user', { displayName: 'x', role: 'admin' }],
      [
        'POST',
        '/api/v1/me/alerts',
        'user',
        { type: 'PRICE_ABOVE', coingeckoId: 'bitcoin', threshold: 1, extra: 1 },
      ],
      ['PATCH', '/api/v1/me/alerts/{id}', 'user', { threshold: 10, type: 'PRICE_BELOW' }],
      ['PATCH', '/api/v1/me/alerts/{id}', 'user', {}],
      ['POST', '/api/v1/admin/coins', 'admin', { coingeckoId: 'bitcoin', extra: true }],
      ['PATCH', '/api/v1/admin/coins/{coingeckoId}', 'admin', { isActive: true, extra: true }],
      ['POST', '/api/v1/admin/notifications/test-email', 'admin', { to: 'someone@example.com' }],
    ];

    it.each(unknownBodyCases)(
      '%s %s rejects an unknown or missing body key',
      async (method, path, auth, body) => {
        const response = await call(
          method,
          expandPath(path, { coingeckoId: 'bitcoin', id: ctx.ids.alertId }),
          { auth, body },
        );

        expect(response.status, response.text).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expectDocumented(response, { method, path });
      },
    );
  });
});

// --- 7.8 Las comprobaciones muerden: deriva simulada sobre copias del documento ---

/** Copia profunda del documento: las mutaciones nunca tocan el documento real. */
function cloneDocument(): JsonObject {
  return structuredClone(doc) as unknown as JsonObject;
}

/** Navega por claves y devuelve el objeto del destino (para mutarlo en una copia). */
function at(root: JsonObject, ...keys: string[]): JsonObject {
  let current: unknown = root;
  for (const key of keys) {
    current = (current as JsonObject)[key];
  }
  return current as JsonObject;
}

describe('el contrato detecta deriva', () => {
  describe('cobertura de rutas', () => {
    it('detecta una ruta servida cuya anotación se quitó, nombrando método y ruta', () => {
      const drifted = cloneDocument();
      delete at(drifted, 'paths')['/api/v1/coins'];

      const gaps: CoverageGaps = findCoverageGaps(drifted, servedRoutes);

      expect(gaps.undocumented).toEqual(['GET /api/v1/coins']);
      expect(gaps.orphaned).toEqual([]);
      expect(formatCoverageGaps(gaps)).toContain('GET /api/v1/coins');
    });

    it('detecta un solo método quitado de una ruta que tiene varios', () => {
      const drifted = cloneDocument();
      delete at(drifted, 'paths', '/api/v1/me/watchlist')['post'];

      expect(findCoverageGaps(drifted, servedRoutes).undocumented).toEqual([
        'POST /api/v1/me/watchlist',
      ]);
    });

    it('detecta una operación documentada que ninguna ruta sirve', () => {
      const drifted = cloneDocument();
      at(drifted, 'paths')['/api/v1/ghost'] = {
        get: { responses: { '200': { description: 'ok' } } },
      };

      const gaps = findCoverageGaps(drifted, servedRoutes);

      expect(gaps.undocumented).toEqual([]);
      expect(gaps.orphaned).toEqual(['GET /api/v1/ghost']);
      expect(formatCoverageGaps(gaps)).toContain('GET /api/v1/ghost');
    });

    it('no reporta nada sobre el documento sin alterar', () => {
      expect(findCoverageGaps(cloneDocument(), servedRoutes)).toEqual({
        undocumented: [],
        orphaned: [],
      });
    });
  });

  describe('validación de respuestas', () => {
    const operation = { method: 'GET', path: '/api/v1/coins/{coingeckoId}' };

    async function realResponse(): Promise<Response> {
      const response = await call('GET', '/api/v1/coins/bitcoin');
      expect(response.status).toBe(200);
      return response;
    }

    function validate(target: object, response: Response, status = response.status) {
      return validateResponse(target, operation, status, bodyOf(response), response.headers);
    }

    it('acepta la respuesta real contra el documento sin alterar', async () => {
      expect(validate(cloneDocument(), await realResponse()).errors).toEqual([]);
    });

    it('detecta un campo renombrado en el esquema y nombra los campos afectados', async () => {
      const drifted = cloneDocument();
      const schema = at(drifted, 'components', 'schemas', 'CoinListItem');
      const properties = at(schema, 'properties');
      properties['ticker'] = properties['symbol'];
      delete properties['symbol'];
      schema['required'] = (schema['required'] as string[]).map((name) =>
        name === 'symbol' ? 'ticker' : name,
      );

      const result = validate(drifted, await realResponse());

      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('GET /api/v1/coins/{coingeckoId} -> 200');
      expect(result.errors.join('\n')).toContain('/data/ticker');
      expect(result.errors.join('\n')).toContain('/data/symbol');
    });

    it('detecta un campo que el código devuelve y la anotación no declara', async () => {
      const drifted = cloneDocument();
      const schema = at(drifted, 'components', 'schemas', 'CoinListItem');
      delete at(schema, 'properties')['name'];
      schema['required'] = (schema['required'] as string[]).filter((name) => name !== 'name');

      const result = validate(drifted, await realResponse());

      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('/data/name');
    });

    it('detecta un cambio de tipo de un campo anidado y nombra su ruta', async () => {
      const drifted = cloneDocument();
      at(drifted, 'components', 'schemas', 'LatestPrice', 'properties', 'priceUsd')['type'] =
        'string';

      const result = validate(drifted, await realResponse());

      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('/data/latest/priceUsd');
      expect(result.errors.join('\n')).toContain('must be string');
    });

    it('detecta un valor de enum que dejó de estar documentado en el envoltorio de error', async () => {
      const drifted = cloneDocument();
      const codes = at(
        drifted,
        'components',
        'schemas',
        'Error',
        'properties',
        'error',
        'properties',
        'code',
      );
      codes['enum'] = (codes['enum'] as string[]).filter((code) => code !== 'NOT_FOUND');

      const response = await call('GET', '/api/v1/coins/no-such-coin');
      expect(response.status).toBe(404);

      const result = validateResponse(drifted, operation, 404, bodyOf(response), response.headers);
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('/error/code');
    });

    it('detecta un header declarado con otro valor del que envía la API', async () => {
      const drifted = cloneDocument();
      at(drifted, 'components', 'headers', 'CacheControlPublic', 'schema')['enum'] = ['no-store'];

      const result = validate(drifted, await realResponse());

      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain("header 'Cache-Control'");
    });

    it('detecta un header declarado que la API no envía', async () => {
      const drifted = cloneDocument();
      at(drifted, 'paths', '/api/v1/coins/{coingeckoId}', 'get', 'responses', '200', 'headers')[
        'X-Not-Sent'
      ] = {
        schema: { type: 'string' },
      };

      const result = validate(drifted, await realResponse());

      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain("falta el header declarado 'X-Not-Sent'");
    });

    it('detecta un status que la operación no documenta', async () => {
      const drifted = cloneDocument();
      delete at(drifted, 'paths', '/api/v1/coins/{coingeckoId}', 'get', 'responses')['404'];

      const response = await call('GET', '/api/v1/coins/no-such-coin');
      const result = validateResponse(
        drifted,
        operation,
        response.status,
        bodyOf(response),
        response.headers,
      );

      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('GET /api/v1/coins/{coingeckoId} -> 404');
      expect(result.errors.join('\n')).toContain('no está documentado');
    });

    it('detecta un cuerpo en una respuesta que se documenta sin contenido', async () => {
      const drifted = cloneDocument();
      delete at(drifted, 'paths', '/api/v1/coins/{coingeckoId}', 'get', 'responses', '200')[
        'content'
      ];

      const result = validate(drifted, await realResponse());

      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('no declara cuerpo');
    });
  });
});

// --- Hermeticidad ---

describe('OpenAPI contract: hermetic execution', () => {
  it('never reached for the network (fetch was not called by the app under test)', () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
