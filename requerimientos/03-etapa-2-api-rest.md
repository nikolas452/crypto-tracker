# Etapa 2 — API REST de lectura: monedas, histórico y estadísticas

> Aplica `00-indice-y-convenciones.md`. Requiere las etapas 0 y 1.

## 1. Objetivo

Exponer por HTTP los datos que el worker guarda: lista de monedas con su último precio, histórico con distintas resoluciones, estadísticas por rango y estado del sistema de jobs. En esta etapa se practican paginación, validación de query params, agregaciones de Mongo, índices, rate limiting y caché HTTP.

## 2. Contexto

El worker ya inserta snapshots en `price_snapshots` y registra `job_runs`. Todavía no hay usuarios: todos los endpoints de esta etapa son públicos, salvo los de admin, que usan una API key temporal hasta la etapa 3.

## 3. Conceptos nuevos de la etapa

- **Query params:** parámetros en la URL (`?page=2&limit=20`). Llegan siempre como string, así que hay que validarlos y convertirlos.
- **Paginación por offset (page/limit):** se salta `(page - 1) × limit` documentos. Es simple y sirve para listas chicas. Con millones de filas se vuelve lenta y se usa **paginación por cursor** (continuar desde el último elemento visto). Acá alcanza con offset; el cursor se menciona para que conozcas la alternativa.
- **Aggregation pipeline:** secuencia de etapas (`$match`, `$sort`, `$group`, `$project`...) que Mongo ejecuta dentro de la base. Cada etapa recibe los documentos de la anterior. Así se calculan promedios o agrupaciones sin traer todos los datos a Node.
- **`$dateTrunc`:** redondea una fecha hacia abajo a una unidad (hora, día). Sirve para agrupar puntos en *buckets* de tiempo.
- **OHLC (open, high, low, close):** para cada bucket, el primer precio, el máximo, el mínimo y el último. Es el formato estándar de los gráficos de velas.
- **`$setWindowFields`:** calcula valores sobre una ventana de documentos vecinos. Acá se usa para la media móvil.
- **Desnormalización ("foto histórica vs entidad viva"):** los snapshots son fotos inmutables del pasado. El último precio es estado vivo que cambia todo el tiempo. Guardar una copia del último precio dentro de `coins` evita consultar la serie temporal en cada request de la lista. El costo es mantener esa copia actualizada, y durante un instante puede diferir del último snapshot (**consistencia eventual**).
- **Índice:** estructura que permite a Mongo encontrar documentos sin recorrer toda la colección. Un índice sirve para una consulta solo si la forma de la consulta coincide con él (campos, orden y tipo de filtro).
- **Rate limiting de tu API:** limitar cuántos requests acepta tu servidor por cliente en una ventana de tiempo, para protegerlo de abusos.
- **`trust proxy`:** en Render (y en la mayoría de las plataformas) tu app está detrás de un proxy. Sin esta configuración, Express ve la IP del proxy y no la del cliente, y el rate limit trataría a todos los usuarios como uno solo.
- **Caché HTTP (`Cache-Control`, `ETag`):** le dice al cliente cuánto tiempo puede reutilizar una respuesta. Con `ETag`, el cliente pregunta "¿cambió?" y, si no cambió, recibe un `304 Not Modified` sin body.
- **Comparación en tiempo constante:** comparar secretos con `crypto.timingSafeEqual`, para que el tiempo de respuesta no revele cuántos caracteres coincidieron.

## 4. Alcance

**Incluye**
- Campo desnormalizado `latest` en `coins`, actualizado por el job.
- `GET /api/v1/coins`, `GET /api/v1/coins/:coingeckoId`, `GET /api/v1/coins/:coingeckoId/history` y `GET /api/v1/coins/:coingeckoId/stats`.
- `GET /api/v1/status`.
- `GET /api/v1/admin/job-runs` y `GET /api/v1/admin/job-runs/:id`, protegidos con API key.
- Rate limiting global, `trust proxy` y cabeceras de caché.
- Script opcional de backfill de histórico.

**No incluye**
- Autenticación de usuarios (etapa 3).
- Escritura de monedas desde la API (etapa 4, admin).
- Paginación por cursor (solo se documenta).

## 5. Cambios al modelo y al job

### RF-2.1 Campo `latest` en `coins`
Se agrega a `coins`:

| Campo | Tipo |
| --- | --- |
| `latest.priceUsd` | number |
| `latest.marketCapUsd` | number \| null |
| `latest.volume24hUsd` | number \| null |
| `latest.change24hPct` | number \| null |
| `latest.capturedAt` | Date |
| `latest.sourceUpdatedAt` | Date \| null |
| `nameLower` | string (para búsqueda) |

- `latest` es `null` hasta el primer snapshot.
- `nameLower` se calcula en un hook `pre('save')` y también en el upsert del seed.

Índices nuevos:
- `{ isActive: 1, "latest.marketCapUsd": -1 }`
- `{ isActive: 1, nameLower: 1 }`
- `{ isActive: 1, symbol: 1 }`
- `{ isActive: 1, "latest.change24hPct": -1 }`

### RF-2.2 El job actualiza `latest`
- Después del `insertMany` de RF-1.4, el job ejecuta **un** `bulkWrite` con un `updateOne` por moneda que tuvo snapshot nuevo, haciendo `$set` de `latest`.
- Condición de cada update: `latest.capturedAt` no existe o es menor que el nuevo `capturedAt`. Así, una ejecución vieja que termina tarde nunca pisa un dato más nuevo.
- Si el `bulkWrite` falla, el run queda `partial` con `error.code: LATEST_UPDATE_FAILED`. Los snapshots ya insertados se conservan y el siguiente run corrige `latest`.
- Se agrega `stats.latestUpdated` a `JobRun`.
- Script `npm run coins:rebuild-latest`: recalcula `latest` de todas las monedas a partir del último snapshot de cada una. Sirve para reparar y para inicializar el campo en datos existentes.

## 6. Contratos de API

### RF-2.3 `GET /api/v1/coins`

**Query params**

| Param | Tipo | Default | Reglas |
| --- | --- | --- | --- |
| `page` | int | 1 | ≥ 1 |
| `limit` | int | 20 | 1–100 |
| `sort` | enum `marketCap` \| `name` \| `symbol` \| `change24h` | `marketCap` | — |
| `order` | enum `asc` \| `desc` | `desc` para `marketCap` y `change24h`; `asc` para `name` y `symbol` | — |
| `q` | string | — | 1–50 caracteres. Busca por **prefijo** en `symbol` o `nameLower`, sin distinguir mayúsculas. |

- No se aceptan query params desconocidos: responde 400 (esquema Zod `strict`).
- Solo devuelve monedas con `isActive: true`.
- `q` se escapa antes de armar la regex (`^` + texto escapado), para evitar inyección de regex y ReDoS. Se busca sobre `nameLower` y `symbol`, que ya están en minúsculas, así la regex no necesita la opción `i` y el índice se aprovecha.
- Las monedas con `latest: null` van al final en cualquier orden.
- Se hace **una** consulta para los datos y **una** para el `total` (`countDocuments` con el mismo filtro). No se usa `$lookup` a la serie temporal.

**Respuesta 200**
```json
{
  "data": [
    {
      "coingeckoId": "bitcoin",
      "symbol": "btc",
      "name": "Bitcoin",
      "latest": {
        "priceUsd": 64210.12,
        "marketCapUsd": 1265000000000,
        "volume24hUsd": 28100000000,
        "change24hPct": -1.23,
        "capturedAt": "2026-09-16T21:30:00.000Z"
      }
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 10, "totalPages": 1 }
}
```

**Headers:** `Cache-Control: public, max-age=60`.

### RF-2.4 `GET /api/v1/coins/:coingeckoId`
- `coingeckoId` se valida con la misma regex que el modelo. Si no pasa, responde 400.
- Si no existe o está inactiva, responde 404 `NOT_FOUND`.
- 200: `{ "data": { coingeckoId, symbol, name, latest, trackedSince } }`, donde `trackedSince` es el `createdAt` de la moneda.
- `Cache-Control: public, max-age=60`.

### RF-2.5 `GET /api/v1/coins/:coingeckoId/history`

**Query params**

| Param | Tipo | Default | Reglas |
| --- | --- | --- | --- |
| `from` | ISO datetime | `to - 7 días` | Debe ser menor que `to` |
| `to` | ISO datetime | ahora | No puede estar más de 5 min en el futuro |
| `interval` | enum `raw` \| `1h` \| `1d` | automático | Ver reglas |
| `sma` | int | — | 2–200. Solo con `1h` o `1d`. |

**Intervalo automático:** si el rango es ≤ 2 días, `raw`; si es ≤ 30 días, `1h`; si es mayor, `1d`.

**Rango máximo por intervalo:**

| Intervalo | Rango máximo |
| --- | --- |
| `raw` | 7 días |
| `1h` | 90 días |
| `1d` | 365 días |

Si se excede, responde 400 `VALIDATION_ERROR` con un mensaje que sugiere un intervalo más grueso.

**Implementación**
- `raw`: `find` por `meta.coingeckoId` y rango de `timestamp`, ordenado ascendente, con proyección de campos. Tope de 2.000 puntos; si hay más, 400 sugiriendo `1h`.
- `1h` / `1d`: pipeline de agregación:
  1. `$match` por moneda y rango.
  2. `$sort` por `timestamp` ascendente (necesario para que `$first` y `$last` den apertura y cierre).
  3. `$group` por `$dateTrunc: { date: "$timestamp", unit: "hour" | "day", timezone: "UTC" }` con `open: $first`, `high: $max`, `low: $min`, `close: $last`, `avg: $avg` y `samples: $sum 1`.
  4. `$sort` por bucket ascendente.
  5. Si viene `sma`: `$setWindowFields` con `sortBy: { bucket: 1 }` y `output.sma: { $avg: "$close", window: { documents: [-(sma - 1), 0] } }`. En los primeros `sma - 1` puntos el valor no es comparable, así que se devuelve `null` (se cuenta la posición con `$documentNumber` o se calcula en la proyección).
- Los buckets sin datos **no** se rellenan.

**Respuesta 200**
```json
{
  "data": {
    "coingeckoId": "bitcoin",
    "interval": "1h",
    "from": "2026-09-09T21:30:00.000Z",
    "to": "2026-09-16T21:30:00.000Z",
    "points": [
      { "t": "2026-09-09T22:00:00.000Z", "open": 1, "high": 2, "low": 0.5, "close": 1.5, "avg": 1.2, "samples": 6, "sma": null }
    ]
  }
}
```
- Con `raw`, cada punto es `{ t, priceUsd, marketCapUsd, volume24hUsd, change24hPct }`.
- Una moneda existente sin datos en el rango responde 200 con `points: []`. Una moneda inexistente responde 404.
- `Cache-Control: public, max-age=60`.

### RF-2.6 `GET /api/v1/coins/:coingeckoId/stats`
- `range`: enum `24h` | `7d` | `30d` | `90d`, default `24h`.
- Un solo pipeline que calcula, dentro del rango: `open` (primer precio), `close` (último), `min`, `max`, `avg`, `samples`, `firstAt` y `lastAt`.
- `changePct = (close - open) / open × 100`, redondeado a 4 decimales en la respuesta.
- Sin datos: 200 con `samples: 0` y el resto de los campos en `null`.
- 200: `{ "data": { coingeckoId, range, from, to, open, close, changePct, min, max, avg, samples, firstAt, lastAt } }`.

### RF-2.7 `GET /api/v1/status`
- Público. Sirve para saber, desde afuera, si el worker funciona.
- Respuesta 200:
```json
{
  "data": {
    "activeCoins": 10,
    "pollPrices": {
      "lastSuccessAt": "2026-09-16T21:30:02.000Z",
      "lastRunAt": "2026-09-16T21:30:00.000Z",
      "lastRunStatus": "success",
      "stale": false
    }
  }
}
```
- `lastSuccessAt` es el `finishedAt` del último run en `success` o `partial`.
- `stale` es `true` si no hubo éxito en los últimos `STALE_POLL_THRESHOLD_MIN` minutos (default 30) o si nunca hubo uno.
- No incluye mensajes de error ni datos internos.
- `Cache-Control: no-store`.

### RF-2.8 Endpoints de admin (protección temporal)
- Middleware `requireAdminKey`:
  - Lee el header `X-Admin-Key` y lo compara con `ADMIN_API_KEY` usando `crypto.timingSafeEqual` (si las longitudes difieren, se considera distinto sin llamar a la función).
  - Si falta o no coincide, responde 401 `UNAUTHENTICATED`.
  - Si `ADMIN_API_KEY` no está configurada, **todas** las rutas `/admin` responden 404, como si no existieran.
- `GET /api/v1/admin/job-runs`:
  - Query: `jobName`, `status` (uno o varios separados por coma), `from`, `to`, `page` y `limit` (máximo 100).
  - Orden: `startedAt` descendente.
  - Formato de lista paginada.
- `GET /api/v1/admin/job-runs/:id`:
  - `id` inválido → 400. Inexistente → 404.
  - Devuelve el documento completo, sin `__v`.
- Todas las respuestas de admin llevan `Cache-Control: no-store`.
- En la etapa 3 esta protección se reemplaza por usuario autenticado con rol `admin`.

### RF-2.9 Rate limiting y proxy
- `app.set('trust proxy', config.TRUST_PROXY)`. `TRUST_PROXY` es entero, con default 0 en desarrollo y 1 en producción.
- `express-rate-limit` 8.x global sobre `/api`: `RATE_LIMIT_MAX` requests (default 300) por ventana de `RATE_LIMIT_WINDOW_MIN` minutos (default 15) por IP.
  - Con las cabeceras estándar `RateLimit-*` habilitadas y las `X-RateLimit-*` deshabilitadas (confirmar el nombre exacto de la opción en la versión instalada).
  - Si se excede, responde 429 con el formato de error global (`RATE_LIMITED`), vía la opción `handler`.
- `/health` y `/health/ready` quedan **fuera** del rate limit.
- Store en memoria. Queda documentado que con más de una instancia de la API haría falta un store compartido, como Redis (etapa 8).

### RF-2.10 Caché HTTP
- Express genera `ETag` débil por defecto. Se verifica que un `If-None-Match` igual responda 304.
- Las cabeceras `Cache-Control` son las indicadas en cada endpoint.

### RF-2.11 (Opcional) Backfill de histórico
- Script `npm run backfill:history -- bitcoin --days 30`.
- Usa `GET /coins/{id}/market_chart?vs_currency=usd&days=N` de CoinGecko. Verificá antes en la documentación si el plan Demo incluye este endpoint y con qué granularidad responde según los días pedidos.
- Inserta en `price_snapshots` con `timestamp` = la marca de cada punto y `sourceUpdatedAt` igual a ese mismo valor.
- Antes de insertar, borra o saltea los puntos del rango que ya existan para esa moneda. La regla elegida se documenta.
- Pide confirmación mostrando cuántas llamadas va a consumir de la cuota mensual.

## 7. Requerimientos no funcionales

- **RNF-2.1:** con 10 monedas y 90 días de datos cada 10 min (≈ 13.000 puntos por moneda), en local:
  - `GET /coins`: p95 < 50 ms.
  - `history` con `1h` y 30 días: p95 < 200 ms.
  - `stats` con `90d`: p95 < 200 ms.
- **RNF-2.2:** ninguna consulta de estos endpoints hace un recorrido completo de colección (`COLLSCAN`). Se verifica con `explain()` y se documenta el resultado en el README.
- **RNF-2.3:** todas las entradas se validan con Zod antes de llegar al service.
- **RNF-2.4:** los services no reciben `req` ni `res`, solo valores tipados.
- **RNF-2.5:** las respuestas nunca incluyen `_id` de Mongo ni `__v` de `coins`. Se definen DTOs de salida.

## 8. Variables de entorno nuevas

| Variable | Default | Uso |
| --- | --- | --- |
| `TRUST_PROXY` | 0 (dev) / 1 (prod) | — |
| `RATE_LIMIT_MAX` | 300 | — |
| `RATE_LIMIT_WINDOW_MIN` | 15 | — |
| `STALE_POLL_THRESHOLD_MIN` | 30 | — |
| `ADMIN_API_KEY` | — | Opcional. Si está, mínimo 32 caracteres. Se genera con `openssl rand -hex 32`. |

## 9. Casos borde

- `from` sin zona horaria (`2026-09-10T10:00`): se rechaza con 400. Solo se acepta ISO con `Z` u offset.
- `from == to`: 400.
- `limit=0`, `limit=abc` o `page=-1`: 400 con `details`.
- `q` con caracteres especiales (`.*[`): se escapan y la búsqueda es literal.
- Moneda inactiva: 404 en detalle, histórico y stats. Su histórico sigue en la base.
- Rango sin datos por un worker caído: `points: []` y `status` muestra `stale: true`.
- Bucket con un solo punto: `open == close == high == low`.
- `sma` mayor que la cantidad de puntos: todos los `sma` quedan en `null`, sin error.

## 10. Criterios de aceptación

- **E2-1:** DADO que hay 12 monedas activas, CUANDO pido `GET /coins?limit=5&page=3`, ENTONCES recibo 2 elementos y `meta: { page: 3, limit: 5, total: 12, totalPages: 3 }`.
- **E2-2:** CUANDO pido `GET /coins?q=BIT`, ENTONCES recibo `bitcoin` (y cualquier otra cuyo nombre o símbolo empiece con "bit"), sin importar mayúsculas.
- **E2-3:** CUANDO pido `GET /coins?sort=change24h&order=asc`, ENTONCES la lista viene ordenada por `latest.change24hPct` ascendente y las monedas sin `latest` al final.
- **E2-4:** CUANDO pido `GET /coins?foo=1`, ENTONCES recibo 400 `VALIDATION_ERROR`.
- **E2-5:** DADO que el job corrió, ENTONCES `coins.latest` coincide con el último snapshot de cada moneda.
- **E2-6:** DADO un run viejo que termina después de uno nuevo, ENTONCES `latest` conserva el dato del run nuevo.
- **E2-7:** DADOS snapshots conocidos de 3 horas, CUANDO pido `history?interval=1h`, ENTONCES recibo 3 puntos con `open`, `high`, `low`, `close`, `avg` y `samples` iguales a los valores calculados a mano.
- **E2-8:** CUANDO pido `history?interval=raw` con un rango de 10 días, ENTONCES recibo 400 que sugiere `1h`.
- **E2-9:** CUANDO pido `history` sin `interval` con un rango de 20 días, ENTONCES `interval` vale `1h`.
- **E2-10:** CUANDO pido `history?interval=1h&sma=3`, ENTONCES los 2 primeros puntos tienen `sma: null` y el tercero tiene el promedio de los 3 `close`.
- **E2-11:** CUANDO pido `GET /coins/no-existe/stats`, ENTONCES recibo 404.
- **E2-12:** DADO que el último run exitoso fue hace 45 minutos, CUANDO pido `GET /status`, ENTONCES `stale` es `true`.
- **E2-13:** CUANDO pido `GET /admin/job-runs` sin `X-Admin-Key`, ENTONCES recibo 401. Con la key correcta, recibo la lista paginada.
- **E2-14:** DADO que `ADMIN_API_KEY` no está configurada, CUANDO pido `GET /admin/job-runs`, ENTONCES recibo 404.
- **E2-15:** DADO `RATE_LIMIT_MAX=3`, CUANDO hago 4 requests seguidos a `/api/v1/coins`, ENTONCES el cuarto recibe 429 `RATE_LIMITED`, y `/health` sigue respondiendo 200.
- **E2-16:** CUANDO repito `GET /coins` con el `ETag` recibido en `If-None-Match`, ENTONCES recibo 304.

## 11. Testing requerido

**Unitarios**
- Esquemas Zod de query: defaults, coerción, rechazos y `strict`.
- Selección de intervalo automático y validación de rango máximo (función pura).
- Escape de regex.
- Cálculo de `changePct`.
- `requireAdminKey`: sin header, header incorrecto, longitud distinta, key correcta y key no configurada.

**Integración** (supertest + mongodb-memory-server, con datos sembrados por helpers)
- E2-1 a E2-16.
- Para E2-7 y E2-10, usar datos fijos con timestamps exactos y resultados esperados escritos a mano en el test.
- Para E2-6, ejecutar la actualización de `latest` con dos `capturedAt` en orden invertido.
- Un test que ejecute `explain('executionStats')` sobre la consulta de la lista y verifique que el plan usa `IXSCAN` y no `COLLSCAN`.

**Performance (manual y documentado)**
- Script que siembre 90 días × 10 monedas y mida RNF-2.1 con `autocannon` u otra herramienta similar.

## 12. Preguntas abiertas

- ¿Querés rellenar con `null` los buckets vacíos del histórico, para que un gráfico muestre huecos? Por defecto no se rellenan.
