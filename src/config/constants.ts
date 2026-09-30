/**
 * `src/config/constants.ts` es la ÚNICA fuente de los valores de configuración
 * no sensibles (puertos, crons, límites, timeouts, retenciones). Los secretos
 * viven en `.env` (ver `.env.example`) y `src/config/env.ts` los combina con
 * estas constantes para armar el objeto `config` que consume el resto de
 * `src/`. Cambiar un valor de acá requiere un commit y un redeploy.
 *
 * Los valores marcados como "override" se pueden sobrescribir opcionalmente
 * desde `process.env` porque dependen del entorno de despliegue (ver
 * `src/config/env.ts`); acá se define su default de desarrollo.
 */

/** Niveles de log soportados por pino. */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

/** Entornos de ejecución soportados. */
export type NodeEnv = 'development' | 'test' | 'production';

export const CONSTANTS = {
  // --- server ---
  // Entorno de ejecución (override por NODE_ENV).
  NODE_ENV: 'development' as NodeEnv,
  // Puerto TCP en el que escucha la API, 1-65535 (override por PORT).
  PORT: 3000,
  // Nombre de la base de datos usada en la conexión a MongoDB.
  MONGODB_DB_NAME: 'crypto_tracker',
  // Nivel de log de pino (override por LOG_LEVEL, útil para silenciar los tests).
  LOG_LEVEL: 'info' as LogLevel,
  // Milisegundos permitidos para el apagado ordenado de la API antes de
  // forzar la salida con código 1. Debe ser >= 1000.
  SHUTDOWN_TIMEOUT_MS: 10000,

  // --- primer-job: cliente de CoinGecko ---
  // URL base de la API de CoinGecko. Raíz de la key Demo, no pro-api.
  COINGECKO_BASE_URL: 'https://api.coingecko.com/api/v3',
  // Timeout HTTP por intento, en ms, para las llamadas a CoinGecko.
  COINGECKO_TIMEOUT_MS: 10000,
  // Reintentos máximos ante fallos reintentables de CoinGecko (0-5).
  COINGECKO_MAX_RETRIES: 2,
  // Máximo de ids de monedas por llamada batch a CoinGecko (1-250).
  COINGECKO_MAX_IDS_PER_CALL: 50,
  // Si `GET /health/ready` incluye el chequeo opcional `coingecko`. Está
  // deshabilitado por defecto: si CoinGecko se cae, la API no debería salir de
  // rotación en el balanceador; el chequeo existe solo para diagnóstico manual.
  COINGECKO_READINESS_ENABLED: false,

  // --- primer-job: job y worker de poll-prices ---
  // Expresión cron (5 campos, UTC) del job poll-prices: cada 10 minutos.
  POLL_PRICES_CRON: '*/10 * * * *',
  // Si el worker también ejecuta el job una vez al arrancar.
  POLL_PRICES_RUN_ON_START: true,
  // Días que se conservan los documentos de price_snapshots antes de expirar
  // (TTL). `null` significa sin expiración.
  SNAPSHOT_RETENTION_DAYS: 90 as number | null,
  // Días que se conservan los documentos de job_runs antes de expirar (TTL).
  JOB_RUNS_RETENTION_DAYS: 30,
  // Minutos tras los cuales un JobRun aún en 'running' se considera colgado y
  // se recupera como fallido al arrancar el worker.
  STALE_RUN_THRESHOLD_MIN: 15,
  // Milisegundos que el worker espera a que termine una ejecución en curso
  // durante el apagado antes de forzar la salida con código 1. Debe ser >= 1000.
  WORKER_SHUTDOWN_TIMEOUT_MS: 30000,

  // --- api-rest: rate limiting y superficie de admin ---
  // Máximo de requests por IP de cliente por ventana RATE_LIMIT_WINDOW_MIN en
  // /api antes de responder 429 RATE_LIMITED. /health y /health/ready están
  // exentos.
  RATE_LIMIT_MAX: 300,
  // Ventana del rate limit, en minutos.
  RATE_LIMIT_WINDOW_MIN: 15,
  // Minutos desde la última ejecución exitosa/parcial de poll-prices antes de
  // que GET /api/v1/status reporte stale: true.
  STALE_POLL_THRESHOLD_MIN: 30,

  // --- auth-firebase: límites por usuario autenticado ---
  // Máximo de requests por minuto por uid autenticado (limitador por usuario,
  // además del límite global por IP).
  USER_RATE_LIMIT_PER_MIN: 120,
  // Minutos de antigüedad de `lastSeenAt` antes de refrescarlo en un request
  // autenticado (spec user-profile).
  LAST_SEEN_THROTTLE_MIN: 5,

  // --- watchlists: límite de ítems por usuario (spec watchlist-store) ---
  WATCHLIST_MAX_ITEMS: 50,

  // --- alertas-email: SMTP, plantilla de correo y jobs de alertas/notificaciones ---
  // Host SMTP (override por SMTP_HOST). Default de desarrollo: Mailpit local
  // (ver docker-compose.yml). El worker lo exige vía assertSmtpCredentials.
  SMTP_HOST: 'localhost',
  // Puerto SMTP (override por SMTP_PORT). 465 selecciona TLS implícito; otro
  // valor no. Mailpit escucha en 1025.
  SMTP_PORT: 1025,
  // Dirección "From" de todo correo saliente (override por MAIL_FROM). Es un
  // placeholder documentado: elegir un remitente productivo, un dominio y
  // SPF/DKIM queda explícitamente fuera del alcance de este proyecto.
  MAIL_FROM: 'alerts@crypto-tracker.local',
  // Zona horaria IANA mostrada como hora local de referencia en el email de
  // alerta, junto a la marca de tiempo UTC que siempre se incluye.
  MAIL_DISPLAY_TIMEZONE: 'America/Argentina/Buenos_Aires',
  // Máximo de notificaciones que envía el job send-notifications por
  // ejecución (tope por minuto); el resto queda pendiente para la siguiente.
  MAIL_MAX_PER_MINUTE: 30,
  // Tope de alertas activas (armed + triggered) por usuario (spec alert-store).
  ALERTS_MAX_ACTIVE: 20,
  // Expresión cron (5 campos, UTC) del job send-notifications: cada minuto.
  SEND_NOTIFICATIONS_CRON: '* * * * *',
  // Máximo de notificaciones reclamadas por ejecución de send-notifications.
  NOTIFY_BATCH_SIZE: 20,
  // Intentos permitidos antes de que un fallo transitorio de envío pase a
  // fallido permanente.
  NOTIFY_MAX_ATTEMPTS: 5,
  // Minutos tras los cuales una notificación atascada en "sending" (murió su
  // worker a mitad del envío) es recuperada por la siguiente ejecución.
  NOTIFY_LOCK_TIMEOUT_MIN: 10,
  // Días que se conservan los documentos de notifications antes de expirar (TTL).
  NOTIFICATIONS_RETENTION_DAYS: 90,

  // --- agenda: scheduler (reemplaza node-cron) ---
  // Backend del scheduler. Punto de extensión documentado a futuro (spec
  // agenda-scheduler / design.md "Decisions"): hoy el único valor soportado
  // es "agenda"; node-cron se eliminó en lugar de mantenerse detrás de un switch.
  // Verificación de versión de driver (design.md "Risks"): `npm ls mongodb`
  // resuelve mongoose 9.10.1 -> mongodb@7.6.0, que satisface el peer
  // dependency de `@agendajs/mongo-backend@4.0.3` (`^6.0.0 || ^7.0.0`, junto
  // con `agenda@6.2.6` exacto). Agenda comparte la conexión existente de
  // Mongoose en lugar de abrir una segunda.
  SCHEDULER: 'agenda',
  // Frecuencia con la que Agenda revisa la colección `agenda_jobs` en busca
  // de trabajo vencido. Introduce latencia de programación de hasta este valor.
  AGENDA_PROCESS_EVERY: '10 seconds',
  // Máximo de jobs que Agenda procesa concurrentemente en este proceso,
  // sumando todos los nombres de job.
  AGENDA_MAX_CONCURRENCY: 5,
  // Días que se conservan los documentos de `agenda_jobs` NO recurrentes
  // (creados por `agenda.now()`) después de finalizar, antes de que el job
  // `maintenance` los elimine.
  AGENDA_ONE_OFF_RETENTION_DAYS: 7,
  // Expresión cron (5 campos, UTC) del job diario de mantenimiento: 03:15 UTC.
  MAINTENANCE_CRON: '15 3 * * *',
  // TTL en milisegundos del lease de `poll-prices` (src/lib/lease-lock.ts),
  // para que un titular muerto no bloquee el recurso para siempre (5 min).
  POLL_LOCK_TTL_MS: 300000,
  // Reintentos adicionales permitidos tras un fallo transitorio de
  // poll-prices (spec job-retry-policy), antes de dejar de reintentar.
  POLL_MAX_JOB_RETRIES: 1,
} as const;
