# Etapa 1 — Primer job: worker con node-cron y snapshots de precios

> Aplica `00-indice-y-convenciones.md`. Requiere la etapa 0 terminada.

## 1. Objetivo

Crear un segundo proceso (**worker**), separado de la API, que a intervalos fijos:

1. Consulte en CoinGecko los precios de las monedas que se siguen.
2. Los guarde como puntos de una serie temporal en MongoDB.
3. Registre cada ejecución (inicio, fin, resultado y métricas) para poder saber si el job funciona sin revisar logs a mano.

## 2. Contexto

Existe la API base con Mongo, config, errores y health checks. En esta etapa no se agregan endpoints nuevos: el resultado se verifica en Compass y con los logs.

## 3. Conceptos nuevos de la etapa

- **Job:** unidad de trabajo que se ejecuta sin que la pida un request HTTP.
- **Scheduler:** componente que decide _cuándo_ se ejecuta un job. Acá es `node-cron`.
- **Expresión cron:** cadena de 5 campos (minuto, hora, día del mes, mes, día de la semana) que describe cuándo ejecutar algo. `*/10 * * * *` significa "cada 10 minutos".
- **Worker:** proceso que ejecuta jobs. Se separa de la API para que un problema en uno no tumbe al otro y para poder escalarlos por separado.
- **Serie temporal / colección time-series:** datos que son "valor en un momento", como un precio a las 21:30. MongoDB 5+ tiene un tipo especial de colección para esto: agrupa internamente los puntos en _buckets_ por rango de tiempo y por el campo `metaField`, y los comprime. Ocupa mucho menos espacio y las consultas por rango de fechas son más rápidas. A cambio, tiene restricciones (por ejemplo, no admite índices únicos) y conviene tratar sus documentos como inmutables.
- **Rate limit y cuota:** límites que impone el proveedor externo. CoinGecko Demo permite 100 llamadas por minuto y 10.000 por mes.
- **Batching:** pedir varias monedas en una sola llamada en vez de una llamada por moneda.
- **Retry con backoff exponencial y jitter:** reintentar una llamada fallida esperando cada vez más (1 s, 3 s...) y con un pequeño componente aleatorio (_jitter_), para no golpear al proveedor justo cuando está con problemas.
- **Overlap:** una ejecución del job empieza cuando la anterior todavía no terminó.
- **Idempotencia (primer contacto):** poder ejecutar algo dos veces sin generar duplicados. Se aplica en el seed y en no guardar el mismo punto de precio dos veces.

## 4. Alcance

**Incluye**

- Modelos `Coin`, `PriceSnapshot` (time-series) y `JobRun`.
- Cliente HTTP de CoinGecko con validación de respuestas, timeouts, reintentos y mapeo de errores.
- Script de seed de monedas.
- Job `poll-prices` con dependencias inyectadas.
- Entrypoint `worker.ts` con node-cron, protección contra overlap, recuperación de ejecuciones colgadas y apagado ordenado.
- Script de ejecución manual del job.

**No incluye**

- Endpoints para leer los datos (etapa 2).
- Alertas (etapa 5).
- Scheduler persistido (etapa 6).

## 5. Decisiones técnicas

- Se usa `fetch` nativo de Node (sin axios), con `AbortSignal.timeout(ms)` para el timeout.
- Base URL: `https://api.coingecko.com/api/v3`. Header: `x-cg-demo-api-key`. Con key Demo, la URL raíz **debe** ser `api.coingecko.com`, no `pro-api`.
- Endpoints de CoinGecko que se usan:
  - `GET /simple/price?ids=<csv>&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true`: en el job.
  - `GET /coins/markets?vs_currency=usd&ids=<csv>`: en el seed, para obtener nombre y símbolo en una sola llamada.
- El timestamp del snapshot (`timestamp`) es el momento en que **tu job** capturó el dato. Aparte se guarda `sourceUpdatedAt`, que es cuándo lo actualizó CoinGecko (`last_updated_at`).
- node-cron corre en UTC (opción `timezone: 'UTC'`).
- node-cron 4 trae una opción para evitar overlap. En esta etapa **igual se implementa a mano** para entender el problema. Documentá en el README si la versión instalada la trae y cómo se compara con tu implementación (verificalo en la documentación de la versión que instales).

## 6. Modelo de datos

### 6.1 `coins` (colección normal)

| Campo                     | Tipo     | Reglas                                            |
| ------------------------- | -------- | ------------------------------------------------- |
| `_id`                     | ObjectId | —                                                 |
| `coingeckoId`             | string   | Obligatorio, único, minúsculas, `^[a-z0-9-]+$`    |
| `symbol`                  | string   | Obligatorio, se guarda en minúsculas              |
| `name`                    | string   | Obligatorio                                       |
| `isActive`                | boolean  | Default `true`. El job solo consulta las activas. |
| `createdAt` / `updatedAt` | Date     | `timestamps: true`                                |

Índices: `{ coingeckoId: 1 }` único y `{ isActive: 1 }`.

### 6.2 `price_snapshots` (colección time-series)

Opciones de la colección:

- `timeField: "timestamp"`
- `metaField: "meta"`
- `granularity: "minutes"`
- `expireAfterSeconds`: `SNAPSHOT_RETENTION_DAYS × 86400`. Si la variable no está definida, no hay expiración.

| Campo              | Tipo           | Reglas                                                                   |
| ------------------ | -------------- | ------------------------------------------------------------------------ |
| `timestamp`        | Date           | Obligatorio. Momento de captura.                                         |
| `meta.coinId`      | ObjectId       | Obligatorio. Referencia a `coins._id`.                                   |
| `meta.coingeckoId` | string         | Obligatorio. Se duplica acá para poder consultar sin cruzar colecciones. |
| `priceUsd`         | number         | Obligatorio, > 0                                                         |
| `marketCapUsd`     | number \| null | —                                                                        |
| `volume24hUsd`     | number \| null | —                                                                        |
| `change24hPct`     | number \| null | —                                                                        |
| `sourceUpdatedAt`  | Date \| null   | Viene de `last_updated_at` (epoch en segundos → Date)                    |

Índice secundario: `{ "meta.coingeckoId": 1, timestamp: -1 }`.

**Por qué `meta` tiene esos campos:** Mongo agrupa los buckets por el valor de `meta`. Si ahí pusieras algo que cambia en cada punto (como el precio), cada documento terminaría en su propio bucket y se perdería la ventaja de la colección. En `meta` va solo lo que identifica la serie, que no cambia.

### 6.3 `job_runs` (colección normal)

| Campo                     | Tipo                                                              | Reglas                                                   |
| ------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| `_id`                     | ObjectId                                                          | Se usa como `runId` en los logs                          |
| `jobName`                 | string                                                            | Por ahora solo `poll-prices`                             |
| `trigger`                 | enum `schedule` \| `manual` \| `startup`                          | —                                                        |
| `status`                  | enum `running` \| `success` \| `partial` \| `failed` \| `skipped` | —                                                        |
| `skipReason`              | enum `overlap` \| `no_active_coins` \| null                       | —                                                        |
| `startedAt`               | Date                                                              | Obligatorio                                              |
| `finishedAt`              | Date \| null                                                      | —                                                        |
| `durationMs`              | number \| null                                                    | —                                                        |
| `stats.coinsRequested`    | number                                                            | —                                                        |
| `stats.coinsReturned`     | number                                                            | —                                                        |
| `stats.snapshotsInserted` | number                                                            | —                                                        |
| `stats.skippedUnchanged`  | number                                                            | —                                                        |
| `stats.missingCoins`      | string[]                                                          | IDs que CoinGecko no devolvió                            |
| `stats.upstreamAttempts`  | number                                                            | Intentos HTTP totales, contando reintentos               |
| `error`                   | `{ code, message }` \| null                                       | Nunca un stack completo ni secretos                      |
| `workerId`                | string                                                            | `hostname-pid`. Sirve para saber qué proceso lo ejecutó. |

Índices:

- `{ jobName: 1, startedAt: -1 }`
- `{ status: 1, startedAt: 1 }`
- TTL sobre `startedAt` con `JOB_RUNS_RETENTION_DAYS` (default 30). Mongo borra solo los documentos vencidos; un proceso interno de la base revisa aproximadamente cada 60 s.

**Estados:**

- `success`: todas las monedas pedidas llegaron y se procesaron.
- `partial`: la llamada funcionó pero faltaron monedas en la respuesta.
- `failed`: error de upstream o de base.
- `skipped`: no se hizo trabajo, por overlap o porque no hay monedas activas.

## 7. Requerimientos funcionales

### RF-1.1 Creación de colecciones al arrancar

- Al iniciar (API, worker y scripts), `ensureCollections()`:
  - Si `price_snapshots` no existe, la crea con las opciones time-series de 6.2 (con `Model.createCollection()` o `db.createCollection`).
  - Si ya existe, verifica con `listCollections` que sea time-series con el mismo `timeField` y `metaField`. Si no lo es, loguea en `fatal` y sale con código 1, con un mensaje que indique cómo corregirlo.
  - Si `SNAPSHOT_RETENTION_DAYS` cambió respecto del valor actual de la colección, lo actualiza con `collMod` y lo loguea en `info`.
- Motivo: si el primer `insert` crea la colección automáticamente, se crea como colección **normal** y ya no se puede convertir a time-series.

### RF-1.2 Cliente de CoinGecko

Módulo `src/integrations/coingecko/` con la interfaz:

```ts
interface CoinGeckoClient {
  getSimplePrices(ids: string[]): Promise<{ prices: Map<string, SimplePrice>; attempts: number }>;
  getMarkets(ids: string[]): Promise<MarketCoin[]>;
  ping(): Promise<void>;
}
type SimplePrice = {
  priceUsd: number;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  change24hPct: number | null;
  sourceUpdatedAt: Date | null;
};
type MarketCoin = { coingeckoId: string; symbol: string; name: string; priceUsd: number };
```

Reglas:

1. **Batching:** los `ids` se dividen en lotes de hasta `COINGECKO_MAX_IDS_PER_CALL` (default 50) y los lotes se piden en secuencia, nunca en paralelo.
2. **Timeout:** `COINGECKO_TIMEOUT_MS` por intento (default 10000).
3. **Validación de la respuesta** con Zod. Un campo que falta o es `null` se mapea a `null`, salvo `usd`: si falta o no es número positivo, se descarta esa moneda y se loguea en `warn`. Si la respuesta entera no tiene la forma esperada, se lanza `UpstreamError` con código interno `COINGECKO_BAD_RESPONSE`.
4. **Mapeo de errores:**

| Situación              | Error lanzado                                           | ¿Reintenta?                                                            |
| ---------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| Timeout o error de red | `UpstreamError` (`COINGECKO_UNAVAILABLE`)               | Sí                                                                     |
| 5xx                    | `UpstreamError` (`COINGECKO_UNAVAILABLE`)               | Sí                                                                     |
| 429                    | `UpstreamError` (`COINGECKO_RATE_LIMITED`)              | Sí, una vez, esperando `Retry-After` si viene y es ≤ 60 s; si no, 30 s |
| 401 / 403              | `UpstreamError` (`COINGECKO_AUTH`), logueado en `error` | No                                                                     |
| Otro 4xx               | `UpstreamError` (`COINGECKO_CLIENT_ERROR`)              | No                                                                     |

5. **Reintentos:** máximo `COINGECKO_MAX_RETRIES` (default 2). Esperas de 1 s y 3 s, cada una con jitter aleatorio de ±20 %. La función de espera se inyecta para poder testear sin esperar de verdad.
6. **Contador de intentos:** `attempts` cuenta todas las llamadas HTTP hechas, reintentos incluidos, para registrar el consumo de cuota.
7. **Logs:** cada llamada loguea en `debug` el path (sin la key), el status y la duración.
8. La API key **nunca** aparece en logs ni en mensajes de error.

### RF-1.3 Seed de monedas (`npm run seed:coins`)

- Entrada:
  - Lista por argumento: `npm run seed:coins -- bitcoin,ethereum`.
  - Si no hay argumento, usa la lista por defecto: `bitcoin, ethereum, solana, cardano, ripple, dogecoin, polkadot, chainlink, litecoin, avalanche-2`.
- Pasos:
  1. Normaliza los IDs (trim y minúsculas) y quita duplicados.
  2. Llama a `getMarkets(ids)`.
  3. Para cada moneda devuelta, hace un upsert por `coingeckoId`, actualizando `name` y `symbol` y activándola (`isActive: true`).
  4. Los IDs que CoinGecko no devolvió se listan como inválidos y **no** se insertan.
  5. Imprime un resumen: creadas, actualizadas, inválidas.
- Es idempotente: correrlo dos veces con la misma lista no crea duplicados.
- Código de salida: 0 si hubo al menos una moneda válida, 1 si ninguna lo fue o si hubo un error.

### RF-1.4 Job `poll-prices`

Implementado como `createPollPricesJob(deps)`, que devuelve `run(trigger): Promise<JobRunResult>`.

Dependencias: `coinsRepo`, `snapshotsRepo`, `jobRunsRepo`, `coingecko`, `clock`, `logger` y `workerId`.

Pasos:

1. Crea un `JobRun` con `status: running` y `startedAt: clock.now()`.
2. Carga las monedas con `isActive: true`. Si no hay, cierra el run como `skipped` (`no_active_coins`) y termina.
3. Llama a `getSimplePrices` con sus `coingeckoId`.
4. **Deduplicación:** con **una sola** agregación sobre `price_snapshots`, obtiene el último `sourceUpdatedAt` de cada moneda pedida (`$match` por `meta.coingeckoId` → `$sort` por `timestamp` descendente → `$group` con `$first`). Si una moneda tiene el mismo `sourceUpdatedAt` que su último snapshot, no se inserta y suma a `skippedUnchanged`. Si alguno de los dos valores es `null`, se inserta igual.
5. Inserta los snapshots nuevos con `insertMany(docs, { ordered: false })`. Todos llevan el mismo `timestamp` (el `clock.now()` del paso 1), así los puntos de una misma corrida quedan alineados.
6. Las monedas pedidas que no volvieron van a `stats.missingCoins` y se loguean en `warn`.
7. Cierra el run con `finishedAt`, `durationMs`, `stats` y un `status`:
   - `success` si `missingCoins` está vacío.
   - `partial` si faltó alguna moneda pero se procesó al menos una.
   - `failed` si no volvió ninguna.
8. Ante cualquier excepción: cierra el run como `failed`, con `error.code` (el código del `UpstreamError` o `INTERNAL`) y `error.message`, y loguea en `error` con stack. **`run()` nunca lanza la excepción hacia afuera:** devuelve el resultado con el estado. El scheduler no debe caerse por un error del job.
9. Loguea en `info` el inicio y el fin, con `runId`, `trigger`, `status`, `durationMs` y `stats`.

### RF-1.5 Protección contra overlap

- El worker mantiene un flag en memoria `isRunning` por job.
- Si llega un tick mientras `isRunning === true`:
  - No ejecuta el job.
  - Crea un `JobRun` con `status: skipped` y `skipReason: overlap`, con `startedAt` y `finishedAt` iguales.
  - Loguea en `warn`.
- El flag se libera en un `finally`, así que se libera aunque el job falle.

### RF-1.6 Entrypoint `src/worker.ts`

Al arrancar:

1. Valida la config (misma función que la API, más las variables de esta etapa).
2. Conecta a Mongo (RF-0.3) y ejecuta `ensureCollections()`.
3. **Recuperación de runs colgados:** marca como `failed` (con `error.code: STALE`) todos los `JobRun` con `status: running` y `startedAt` anterior a `now - STALE_RUN_THRESHOLD_MIN` (default 15). Esto cubre el caso de un worker que murió a mitad de una ejecución.
4. Valida `POLL_PRICES_CRON` con `cron.validate()`. Si es inválida, sale con código 1.
5. Programa el job con `cron.schedule(POLL_PRICES_CRON, handler, { timezone: 'UTC', name: 'poll-prices' })`.
6. Si `POLL_PRICES_RUN_ON_START=true` (default `true`), ejecuta el job una vez con `trigger: startup`.
7. Loguea en `info`: `workerId`, la expresión cron y la cantidad de monedas activas.

El worker **no** levanta servidor HTTP.

### RF-1.7 Apagado ordenado del worker

Ante `SIGTERM` o `SIGINT`:

1. Detiene las tareas de node-cron (`task.stop()`), así que no arrancan ejecuciones nuevas.
2. Si hay un job corriendo, espera hasta `WORKER_SHUTDOWN_TIMEOUT_MS` (default 30000) a que termine.
3. Cierra la conexión a Mongo y sale con código 0.
4. Si se agota el timeout, sale con código 1 sin tocar el run. La recuperación de RF-1.6 lo marcará como `STALE` en el próximo arranque.

### RF-1.8 Ejecución manual (`npm run job:poll-prices`)

- Conecta, ejecuta `ensureCollections()`, ejecuta el job **una vez** con `trigger: manual`, imprime el resultado y sale.
- Código de salida: 0 si el estado es `success`, `partial` o `skipped`; 1 si es `failed`.
- No respeta el flag de overlap del worker, porque es otro proceso. Se documenta como limitación: si coincide con una ejecución del worker puede haber dos corridas simultáneas. La deduplicación de RF-1.4 evita puntos repetidos, y la etapa 6 resuelve el problema de fondo con locks.

### RF-1.9 Scripts npm nuevos

`dev:worker`, `start:worker`, `seed:coins` y `job:poll-prices`.

## 8. Requerimientos no funcionales

- **RNF-1.1 (cuota):** con la configuración por defecto (10 monedas, cada 10 min), el consumo estimado es ≤ 4.500 llamadas por mes. El README documenta la fórmula: `llamadas/mes ≈ (60 / intervalo_min) × 24 × 31 × ceil(monedas / 50)`, más los seeds y las ejecuciones manuales.
- **RNF-1.2:** con 10 monedas y CoinGecko respondiendo normal, una ejecución tarda menos de 5 s.
- **RNF-1.3:** el worker no crece en memoria entre ejecuciones (no acumula resultados en variables globales).
- **RNF-1.4:** a ninguna hora el worker supera 1 llamada por segundo a CoinGecko.
- **RNF-1.5:** la API key solo existe en las variables de entorno.

## 9. Variables de entorno nuevas

| Variable                     | Obligatoria | Default                            | Uso                          |
| ---------------------------- | ----------- | ---------------------------------- | ---------------------------- |
| `COINGECKO_API_KEY`          | Sí          | —                                  | Key del plan Demo            |
| `COINGECKO_BASE_URL`         | No          | `https://api.coingecko.com/api/v3` | —                            |
| `COINGECKO_TIMEOUT_MS`       | No          | `10000`                            | —                            |
| `COINGECKO_MAX_RETRIES`      | No          | `2`                                | 0–5                          |
| `COINGECKO_MAX_IDS_PER_CALL` | No          | `50`                               | 1–250                        |
| `POLL_PRICES_CRON`           | No          | `*/10 * * * *`                     | Validada con `cron.validate` |
| `POLL_PRICES_RUN_ON_START`   | No          | `true`                             | —                            |
| `SNAPSHOT_RETENTION_DAYS`    | No          | `90`                               | Vacío = sin expiración       |
| `JOB_RUNS_RETENTION_DAYS`    | No          | `30`                               | —                            |
| `STALE_RUN_THRESHOLD_MIN`    | No          | `15`                               | —                            |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | No          | `30000`                            | —                            |

`COINGECKO_API_KEY` es obligatoria solo para el worker y los scripts. La API no la necesita hasta la etapa 4, así que conviene tener un esquema de config por proceso o marcarla como obligatoria solo en esos entrypoints.

## 10. Casos borde

- CoinGecko devuelve 200 pero sin alguna moneda (ID dado de baja): el run queda `partial` y la moneda aparece en `missingCoins`. No se desactiva sola; eso queda a criterio del admin (etapa 4).
- `usd` es 0 o negativo: se descarta esa moneda y se loguea en `warn`.
- La API key es inválida (401): el run queda `failed` con `COINGECKO_AUTH`. El worker sigue vivo y vuelve a intentar en el próximo tick.
- 429 repetido: tras un reintento, el run queda `failed` con `COINGECKO_RATE_LIMITED`. No se reintenta indefinidamente.
- Mongo se cae a mitad del `insertMany`: el run queda `failed` si se puede escribir; si no, queda `running` y lo recupera RF-1.6.
- El reloj del servidor cambia: todo usa UTC y `clock.now()`.
- Se cambia `POLL_PRICES_CRON` y se reinicia el worker: toma el nuevo valor sin migraciones.

## 11. Criterios de aceptación

- **E1-1:** DADO que la base está vacía, CUANDO corro `seed:coins` sin argumentos, ENTONCES se crean las 10 monedas por defecto y el comando sale con 0. CUANDO lo corro de nuevo, ENTONCES no se crean duplicados y el resumen informa 10 actualizadas.
- **E1-2:** DADO `seed:coins -- bitcoin,no-existe-xyz`, ENTONCES se crea o actualiza `bitcoin` y `no-existe-xyz` aparece como inválida.
- **E1-3:** DADO que el worker arranca con la colección `price_snapshots` inexistente, ENTONCES queda creada como time-series con `timeField: timestamp` y `metaField: meta`.
- **E1-4:** DADO que `price_snapshots` existe como colección normal, CUANDO arranca el worker, ENTONCES termina con código 1 y un mensaje explicativo.
- **E1-5:** DADO que hay 3 monedas activas y CoinGecko responde las 3, CUANDO corre el job, ENTONCES se insertan 3 snapshots con el mismo `timestamp` y hay un `JobRun` en `success` con `snapshotsInserted: 3`.
- **E1-6:** DADO que CoinGecko devuelve el mismo `last_updated_at` que el último snapshot de `bitcoin`, CUANDO corre el job, ENTONCES no se inserta un punto nuevo para `bitcoin` y `skippedUnchanged` vale 1.
- **E1-7:** DADO que CoinGecko devuelve 2 de 3 monedas, ENTONCES el run queda `partial` con la faltante en `missingCoins`.
- **E1-8:** DADO que CoinGecko responde 503 dos veces y después 200, ENTONCES el run queda `success` con `upstreamAttempts: 3`.
- **E1-9:** DADO que CoinGecko responde 503 en todos los intentos, ENTONCES el run queda `failed` con `error.code: COINGECKO_UNAVAILABLE` y el worker sigue corriendo.
- **E1-10:** DADO que hay un job en curso, CUANDO llega otro tick, ENTONCES se registra un run `skipped` con `skipReason: overlap` y no se hace ninguna llamada a CoinGecko.
- **E1-11:** DADO un `JobRun` en `running` con 20 minutos de antigüedad, CUANDO arranca el worker, ENTONCES ese run pasa a `failed` con `error.code: STALE`.
- **E1-12:** DADO que no hay monedas activas, CUANDO corre el job, ENTONCES el run queda `skipped` con `skipReason: no_active_coins` y no se llama a CoinGecko.
- **E1-13:** DADO que el worker está corriendo, CUANDO se inspeccionan los logs, ENTONCES no aparece la API key en ningún log.

## 12. Testing requerido

**Unitarios**

- Cliente CoinGecko con `fetch` falso (`vi.stubGlobal('fetch', ...)`) y función de espera falsa:
  - Mapeo correcto de campos, incluidos `null` y epoch → Date.
  - Descarte de `usd` inválido.
  - Respuesta con forma incorrecta → `COINGECKO_BAD_RESPONSE`.
  - Cada fila de la tabla de errores de RF-1.2.
  - Reintentos y conteo de `attempts`.
  - Respeto de `Retry-After` con tope.
  - Batching: 120 IDs con límite 50 → 3 llamadas en secuencia.
  - La key no aparece en los mensajes de error.
- Job `poll-prices` con repositorios y cliente falsos: E1-5 a E1-9 y E1-12. Verificar que `run()` nunca lanza.
- Guard de overlap: dos invocaciones concurrentes → una ejecuta y la otra registra `skipped`.
- Cálculo de estado (`success` / `partial` / `failed`) como función pura.

**Integración** (mongodb-memory-server)

- E1-3 y E1-4, verificados con `listCollections`.
- Seed idempotente (E1-1) con un cliente CoinGecko falso.
- Deduplicación con datos reales en la colección time-series (E1-6).
- Recuperación de runs colgados (E1-11).
- TTL: el índice existe con el `expireAfterSeconds` esperado. No se espera a que Mongo borre documentos.

**Manual**

- Correr el worker con la key real durante 30 minutos y verificar en Compass los snapshots y los `job_runs`.

## 13. Preguntas abiertas

- ¿Querés que la lista de monedas por defecto sea otra? Cambia solo el seed.
