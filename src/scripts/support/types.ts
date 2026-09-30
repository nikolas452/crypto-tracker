/**
 * Tipos e interfaces compartidos por los scripts de `src/scripts`, agrupados
 * por script. Los scripts conservan solo su flujo; los contratos de datos
 * viven acá.
 */
import type { Types } from 'mongoose';
import type { Logger } from 'pino';
import type { CoinGeckoClient, MarketChartPoint } from '../../integrations/coingecko/coingecko.types.js';
import type { CoinsRepo } from '../../modules/coins/coins.service.js';
import type { NewSnapshotInput } from '../../modules/snapshots/snapshots.service.js';
import type { UserRole } from '../../modules/users/users.model.js';

// ---------------------------------------------------------------------------
// seedCoins
// ---------------------------------------------------------------------------

export interface SeedCoinsDeps {
  readonly coingecko: Pick<CoinGeckoClient, 'getMarkets'>;
  readonly coinsRepo: CoinsRepo;
  readonly logger: Logger;
}

export interface SeedSummary {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly invalid: readonly string[];
}

// ---------------------------------------------------------------------------
// rebuildLatest
// ---------------------------------------------------------------------------

export interface RebuildLatestSummary {
  /** Cantidad de monedas cuyo `latest` fue efectivamente sobrescrito. */
  readonly updated: number;
  /** Monedas sin ningún documento de `price_snapshots` — se reportan, no se consideran un fallo. */
  readonly noSnapshots: readonly string[];
}

// ---------------------------------------------------------------------------
// backfillHistory
// ---------------------------------------------------------------------------

export interface BackfillArgs {
  readonly coingeckoId: string;
  readonly days: number;
  readonly skipConfirm: boolean;
}

export interface BackfillHistorySummary {
  readonly imported: number;
  readonly skipped: number;
}

export interface RunBackfillHistoryDeps {
  readonly coingeckoId: string;
  readonly coinId: Types.ObjectId;
  readonly points: readonly MarketChartPoint[];
  /** Inyectado para que los tests unitarios nunca toquen una base de datos real. */
  readonly getExistingTimestamps: (
    coingeckoId: string,
    from: Date,
    to: Date,
  ) => Promise<Set<number>>;
  readonly insertSnapshots: (docs: readonly NewSnapshotInput[]) => Promise<number>;
}

// ---------------------------------------------------------------------------
// authToken
// ---------------------------------------------------------------------------

export interface AuthTokenArgs {
  readonly email: string;
  readonly password: string;
}

export interface SignInWithPasswordResponse {
  readonly idToken: string;
}

// ---------------------------------------------------------------------------
// createTestUser
// ---------------------------------------------------------------------------

export interface CreateTestUserArgs {
  readonly email: string;
  readonly password: string;
  readonly admin: boolean;
}

// ---------------------------------------------------------------------------
// setRole
// ---------------------------------------------------------------------------

export interface SetRoleArgs {
  readonly email: string;
  readonly role: UserRole;
}

// ---------------------------------------------------------------------------
// perf (compartido)
// ---------------------------------------------------------------------------

export interface LatencyStats {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

// ---------------------------------------------------------------------------
// perf/coinsListPerf
// ---------------------------------------------------------------------------

export interface SnapshotSeed {
  readonly timestamp: Date;
  readonly meta: { readonly coinId: unknown; readonly coingeckoId: string };
  readonly priceUsd: number;
  readonly marketCapUsd: number;
  readonly volume24hUsd: number;
  readonly change24hPct: null;
  readonly sourceUpdatedAt: Date;
}
