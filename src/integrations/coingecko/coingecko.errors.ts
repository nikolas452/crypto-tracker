import { UpstreamError, type AppErrorOptions } from '../../lib/errors.js';

/**
 * Errores internos del cliente de CoinGecko, con su propio espacio de
 * códigos anidado dentro del `ErrorCode` externo del proyecto.
 */

/**
 * Códigos de error internos del cliente de CoinGecko — distintos de (y
 * anidados dentro de) el espacio `ErrorCode` externo del proyecto. Esto es
 * lo que alimenta `JobRun.error.code` y sobre lo que decide la propia
 * política de reintentos del cliente.
 */
export type CoinGeckoErrorCode =
  | 'COINGECKO_UNAVAILABLE'
  | 'COINGECKO_RATE_LIMITED'
  | 'COINGECKO_AUTH'
  | 'COINGECKO_CLIENT_ERROR'
  | 'COINGECKO_BAD_RESPONSE';

export interface CoinGeckoErrorOptions extends AppErrorOptions {
  /** Si el loop de reintentos del cliente debe reintentar este fallo. */
  readonly retryable?: boolean;
}

/**
 * Lanzado por el cliente de CoinGecko. Extiende el `UpstreamError` del
 * proyecto (HTTP 502 / `UPSTREAM_ERROR` hacia afuera) con un `internalCode`
 * que distingue el fallo upstream específico según la tabla de errores
 * RF-1.2. El mensaje nunca incluye la API key ni una URL completa que la
 * contenga.
 */
export class CoinGeckoError extends UpstreamError {
  readonly internalCode: CoinGeckoErrorCode;
  readonly retryable: boolean;

  constructor(
    internalCode: CoinGeckoErrorCode,
    message: string,
    options: CoinGeckoErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'CoinGeckoError';
    this.internalCode = internalCode;
    this.retryable = options.retryable ?? false;
  }
}
