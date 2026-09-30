import { describe, expect, it } from 'vitest';
import { runSmoke } from '../../src/scripts/smoke.js';

/**
 * Tests unitarios de `runSmoke` (spec smoke-test): el contrato de exit code
 * y que un `stale: true` degrada a warning en vez de fallar el chequeo.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function buildFakeFetch(overrides: Partial<Record<string, Response>> = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    const path = url.pathname + url.search;

    if (overrides[path]) {
      return overrides[path]!;
    }
    if (path === '/health') return jsonResponse(200, { status: 'ok' });
    if (path === '/health/ready') return jsonResponse(200, { status: 'ready' });
    if (path === '/api/v1/coins?limit=1') return jsonResponse(200, { data: [{ id: 'bitcoin' }] });
    if (path === '/api/v1/status') {
      return jsonResponse(200, { data: { pollPrices: { stale: false } } });
    }
    if (path === '/api/v1/me') return jsonResponse(401, { error: { code: 'UNAUTHENTICATED' } });

    return jsonResponse(404, {});
  }) as unknown as typeof fetch;
}

describe('runSmoke', () => {
  it('passes every check against a healthy deployment', async () => {
    const results = await runSmoke('https://api.example.test', { fetchFn: buildFakeFetch() });

    expect(results.every((result) => result.outcome === 'pass')).toBe(true);
  });

  it('degrades the status check to a warning when stale is true, without failing the run', async () => {
    const fetchFn = buildFakeFetch({
      '/api/v1/status': jsonResponse(200, { data: { pollPrices: { stale: true } } }),
    });

    const results = await runSmoke('https://api.example.test', { fetchFn });

    const statusResult = results.find((result) => result.name === 'GET /api/v1/status');
    expect(statusResult?.outcome).toBe('warn');
    expect(results.some((result) => result.outcome === 'fail')).toBe(false);
  });

  it('fails the readiness check when it does not return 200', async () => {
    const fetchFn = buildFakeFetch({
      '/health/ready': jsonResponse(503, { status: 'not_ready' }),
    });

    const results = await runSmoke('https://api.example.test', { fetchFn });

    const readyResult = results.find((result) => result.name === 'GET /health/ready');
    expect(readyResult?.outcome).toBe('fail');
  });

  it('fails the auth check when /api/v1/me does not return 401 for an unauthenticated request', async () => {
    const fetchFn = buildFakeFetch({
      '/api/v1/me': jsonResponse(200, { data: {} }),
    });

    const results = await runSmoke('https://api.example.test', { fetchFn });

    const meResult = results.find((result) => result.name === 'GET /api/v1/me (no token)');
    expect(meResult?.outcome).toBe('fail');
  });
});
