import { UpstreamError, type AppErrorOptions } from '../../lib/errors.js';

/**
 * Internal error codes for the CoinGecko client — distinct from (and nested
 * inside) the project's outward `ErrorCode` space. This is what feeds
 * `JobRun.error.code` and what the client's own retry policy switches on.
 */
export type CoinGeckoErrorCode =
  | 'COINGECKO_UNAVAILABLE'
  | 'COINGECKO_RATE_LIMITED'
  | 'COINGECKO_AUTH'
  | 'COINGECKO_CLIENT_ERROR'
  | 'COINGECKO_BAD_RESPONSE';

export interface CoinGeckoErrorOptions extends AppErrorOptions {
  /** Whether the client's retry loop should retry this failure. */
  readonly retryable?: boolean;
}

/**
 * Thrown by the CoinGecko client. Extends the project's `UpstreamError`
 * (outward HTTP 502 / `UPSTREAM_ERROR`) with an `internalCode` that
 * distinguishes the specific upstream failure per the RF-1.2 error table.
 * The message never includes the API key or a full URL containing it.
 */
export class CoinGeckoError extends UpstreamError {
  readonly internalCode: CoinGeckoErrorCode;
  readonly retryable: boolean;

  constructor(internalCode: CoinGeckoErrorCode, message: string, options: CoinGeckoErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'CoinGeckoError';
    this.internalCode = internalCode;
    this.retryable = options.retryable ?? false;
  }
}
