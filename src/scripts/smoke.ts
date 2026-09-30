import { fileURLToPath } from 'node:url';

/**
 * Script `smoke` (spec smoke-test, deploy-render tarea 7.1): cinco chequeos
 * post-deploy contra una URL real (`npm run smoke -- --url <api>`),
 * respondiendo "¿esta instancia desplegada está sirviendo?" — no "¿el código
 * es correcto?", que ya responde el resto de la suite de tests. Contrato de
 * exit code (tarea 7.2): 1 si cualquier chequeo falla, salvo que el de
 * `/api/v1/status` puede degradar a warning sin fallar el script. Tolera el
 * cold start del plan free (tarea 7.3): el primer request reintenta durante
 * hasta ~1 minuto en vez de fallar de entrada.
 */

export interface SmokeCheckResult {
  readonly name: string;
  readonly outcome: 'pass' | 'fail' | 'warn';
  readonly detail: string;
}

const COLD_START_MAX_ATTEMPTS = 12;
const COLD_START_RETRY_DELAY_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Solo el PRIMER request de la corrida pasa por acá (spec: "el cold start no
 * debe causar una falla espuria en el primer request"): reintenta con espera
 * fija ante un error de red o cualquier respuesta no exitosa, en lugar de
 * fallar el chequeo de entrada. Una vez que la instancia responde una vez,
 * el resto de los chequeos van sin reintento — ya está despierta.
 */
async function fetchTolerant(url: string, fetchFn: typeof fetch): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= COLD_START_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchFn(url);
      if (response.ok || attempt === COLD_START_MAX_ATTEMPTS) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(COLD_START_RETRY_DELAY_MS);
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('smoke: unknown error waiting for the service to wake up');
}

export interface RunSmokeDeps {
  readonly fetchFn?: typeof fetch;
}

/**
 * Lógica pura de `smoke`: corre los cinco chequeos contra `baseUrl` y
 * devuelve un resultado por chequeo, sin nunca llamar a `process.exit`.
 * Separada del entrypoint de CLI de abajo para poder testearla con un
 * `fetchFn` falso, mismo patrón que `runSeedCoins`/`runDbSetup`.
 */
export async function runSmoke(
  baseUrl: string,
  deps: RunSmokeDeps = {},
): Promise<SmokeCheckResult[]> {
  const fetchFn = deps.fetchFn ?? fetch;
  const resolve = (path: string): string => new URL(path, baseUrl).toString();
  const results: SmokeCheckResult[] = [];

  try {
    const res = await fetchTolerant(resolve('/health'), fetchFn);
    results.push({
      name: 'GET /health',
      outcome: res.status === 200 ? 'pass' : 'fail',
      detail: `status ${res.status}`,
    });
  } catch (error) {
    results.push({ name: 'GET /health', outcome: 'fail', detail: String(error) });
  }

  try {
    const res = await fetchFn(resolve('/health/ready'));
    results.push({
      name: 'GET /health/ready',
      outcome: res.status === 200 ? 'pass' : 'fail',
      detail: `status ${res.status}`,
    });
  } catch (error) {
    results.push({ name: 'GET /health/ready', outcome: 'fail', detail: String(error) });
  }

  try {
    const res = await fetchFn(resolve('/api/v1/coins?limit=1'));
    const body = (await res.json().catch(() => null)) as { data?: unknown[] } | null;
    const itemCount = Array.isArray(body?.data) ? body.data.length : -1;
    const pass = res.status === 200 && itemCount >= 0 && itemCount <= 1;
    results.push({
      name: 'GET /api/v1/coins?limit=1',
      outcome: pass ? 'pass' : 'fail',
      detail: `status ${res.status}, items ${itemCount}`,
    });
  } catch (error) {
    results.push({ name: 'GET /api/v1/coins?limit=1', outcome: 'fail', detail: String(error) });
  }

  try {
    const res = await fetchFn(resolve('/api/v1/status'));
    const body = (await res.json().catch(() => null)) as {
      data?: { pollPrices?: { stale?: boolean } };
    } | null;

    if (res.status !== 200) {
      results.push({
        name: 'GET /api/v1/status',
        outcome: 'fail',
        detail: `status ${res.status}`,
      });
    } else if (body?.data?.pollPrices?.stale) {
      results.push({
        name: 'GET /api/v1/status',
        outcome: 'warn',
        detail:
          'pollPrices.stale=true — estado normal en este deployment: ningún worker corre en la nube (ver docs/runbook.md)',
      });
    } else {
      results.push({
        name: 'GET /api/v1/status',
        outcome: 'pass',
        detail: 'status 200, stale=false',
      });
    }
  } catch (error) {
    results.push({ name: 'GET /api/v1/status', outcome: 'fail', detail: String(error) });
  }

  try {
    const res = await fetchFn(resolve('/api/v1/me'));
    results.push({
      name: 'GET /api/v1/me (no token)',
      outcome: res.status === 401 ? 'pass' : 'fail',
      detail: `status ${res.status}`,
    });
  } catch (error) {
    results.push({ name: 'GET /api/v1/me (no token)', outcome: 'fail', detail: String(error) });
  }

  return results;
}

function parseArgs(argv: readonly string[]): { readonly url: string } {
  const index = argv.indexOf('--url');
  const url = index >= 0 ? argv[index + 1] : undefined;

  if (!url) {
    throw new Error('Usage: npm run smoke -- --url <api>');
  }

  return { url };
}

function printResults(results: readonly SmokeCheckResult[]): void {
  for (const result of results) {
    const marker = result.outcome === 'pass' ? 'PASS' : result.outcome === 'warn' ? 'WARN' : 'FAIL';
    console.log(`[${marker}] ${result.name} — ${result.detail}`);
  }
}

async function main(): Promise<void> {
  const { url } = parseArgs(process.argv.slice(2));

  const results = await runSmoke(url);
  printResults(results);

  const hasFailure = results.some((result) => result.outcome === 'fail');
  process.exitCode = hasFailure ? 1 : 0;
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main().catch((err: unknown) => {
    console.error('smoke: unexpected error', err);
    process.exitCode = 1;
  });
}
