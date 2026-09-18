# Etapa 6 — Jobs persistidos con Agenda

> Aplica `00-indice-y-convenciones.md`. Requiere las etapas 0 a 5.
> Versiones relevadas: `agenda` 6.2.6 y `@agendajs/mongo-backend` 4.0.3. Agenda 6 es una reescritura completa en TypeScript, **solo ESM**, con cambios incompatibles respecto de la v5. Muchos tutoriales en internet usan la v5: tomá como referencia la [documentación oficial de v6](https://github.com/agenda/agenda) y su guía de migración.

## 1. Objetivo

Reemplazar node-cron por Agenda para que la programación y el estado de los jobs vivan en MongoDB y no en la memoria del proceso. Así se puede:
- Correr más de un worker sin que los jobs se dupliquen.
- Ver y controlar los jobs desde la API (ejecutar ahora, pausar, reanudar).
- Reintentar fallas con una política explícita.
- Apagar los workers sin perder trabajo.

## 2. Contexto

El worker usa node-cron con dos tareas (`poll-prices` y `send-notifications`) y guards de overlap en memoria. Las limitaciones que quedaron documentadas:
- Una ejecución manual puede superponerse con la del worker.
- Con dos workers, cada uno ejecutaría su propia agenda.
- No hay forma de disparar o pausar jobs desde la API.

## 3. Conceptos nuevos de la etapa

- **Scheduler persistido:** la definición de cuándo corre cada job (`nextRunAt`) se guarda como documento en Mongo (colección `agenda_jobs`). Si el worker se reinicia, retoma desde ahí.
- **Polling del scheduler:** Agenda consulta la colección cada `processEvery` (por ejemplo, 10 s) para buscar jobs vencidos. Un job programado para las 21:30:00 puede empezar hasta `processEvery` más tarde. Es un trade-off entre precisión y carga sobre la base.
- **Lock de job:** cuando un worker toma un job, escribe `lockedAt` en su documento. Los demás workers ignoran los jobs bloqueados. Si el worker muere, el lock "vence" después de `lockLifetime` y otro worker puede tomarlo. Por eso `lockLifetime` tiene que ser mayor que la duración normal del job. Si el job es largo, se renueva con `job.touch()`.
- **Concurrencia en Agenda:** `concurrency` y `lockLimit` limitan cuántos jobs de un mismo nombre procesa **cada instancia** de Agenda. No limitan entre workers distintos cuando hay varios documentos con el mismo nombre (por ejemplo, el recurrente y uno disparado con `now()`).
- **Lease lock (lock con vencimiento):** mutex distribuido hecho a mano en Mongo. Un documento por recurso (`_id: 'poll-prices'`), con `lockedBy` y `lockedUntil`. Se adquiere con un update atómico y vence solo si el dueño muere. Cubre el hueco del punto anterior.
- **Productor vs consumidor:**
  - La API es **productora**: crea jobs (`now`, `schedule`) pero no los procesa. Crea una instancia de Agenda sin llamar a `start()`.
  - El worker es **consumidor**: llama a `start()` y procesa.
- **Job recurrente vs job único:**
  - `every()` mantiene **un** documento por nombre que se reprograma solo.
  - `now()` y `schedule()` crean documentos de una sola ejecución, que quedan guardados después de terminar. Si no se limpian, se acumulan.
- **`stop()` vs `drain()`:**
  - `drain()` espera a que terminen los jobs en curso (con timeout).
  - `stop()` corta y libera los locks para que otro worker los retome.
- **202 Accepted:** status HTTP para "recibí tu pedido y lo voy a procesar después". Es el correcto cuando un endpoint encola trabajo en vez de hacerlo en el momento.

## 4. Alcance

**Incluye**
- Instalación de `agenda` y `@agendajs/mongo-backend`, reutilizando la conexión de Mongoose.
- Migración de `poll-prices` y `send-notifications` a Agenda.
- Nuevo job `maintenance`.
- Lease lock para `poll-prices`.
- Política de reintentos.
- Apagado con `drain`.
- Endpoints de admin para ver y controlar jobs.
- Limpieza de jobs únicos terminados.
- Remoción de node-cron (o convivencia opcional mediante `SCHEDULER`).

**No incluye**
- Notificaciones en tiempo real entre procesos (pub/sub).
- Dashboard web (Agendash queda como opcional; verificar su compatibilidad con v6).
- BullMQ (etapa 8).

## 5. Decisiones técnicas

- **Una sola conexión a Mongo:** `new MongoBackend({ mongo: mongoose.connection.db, collection: 'agenda_jobs' })`.
  - Riesgo: `@agendajs/mongo-backend` declara como peer `mongodb ^6 || ^7`. Hay que verificar con `npm ls mongodb` que Mongoose y Agenda usen **la misma** versión del driver. Si no, usar `address` con la URI y aceptar una segunda conexión. La decisión se documenta.
- Los jobs se definen **solo** en el worker. La API crea su instancia de Agenda como productora (sin `start()`), con la misma colección.
- `processEvery`: `AGENDA_PROCESS_EVERY` (default `'10 seconds'`).
- Toda la lógica de negocio sigue en `src/jobs/*`. Los handlers de Agenda son adaptadores finos: leen `job.attrs.data`, llaman a la lógica y traducen el resultado.
- Los nombres de jobs se centralizan en una constante: `JOB_NAMES = { POLL_PRICES: 'poll-prices', SEND_NOTIFICATIONS: 'send-notifications', MAINTENANCE: 'maintenance' } as const`.
- **Si una opción o método de Agenda v6 citado acá no existe con ese nombre en la versión instalada, se usa el equivalente de la documentación de v6 y se deja anotado en el README.** Los nombres de este documento salen del README de la 6.2.6: `define` con `concurrency`, `lockLimit`, `lockLifetime` y `priority`; `every`, `now`, `schedule`, `cancel`, `disable`, `enable`, `stop`, `drain(timeoutMs)`; y los eventos `start`, `success`, `fail` y `complete`.

## 6. Modelo de datos

### 6.1 `agenda_jobs`
Colección administrada por Agenda. **La app no escribe en ella directamente.** Solo lee (para el admin) a través de la API de Agenda o, si no alcanza, con consultas de solo lectura.

### 6.2 `job_locks` (nueva)

| Campo | Tipo | Reglas |
| --- | --- | --- |
| `_id` | string | Nombre del recurso (`poll-prices`) |
| `lockedBy` | string | `workerId` + `runId` |
| `lockedUntil` | Date | — |
| `acquiredAt` | Date | — |

### 6.3 Cambios en `job_runs`
- `trigger` suma los valores `agenda`, `retry` y `api`. `schedule` queda solo para el modo node-cron.
- `skipReason` suma `locked`.
- Campo nuevo `agendaJobId` (string \| null).
- Campo nuevo `attempt` (int, default 1).

## 7. Requerimientos funcionales

### RF-6.1 Instancia de Agenda (`src/scheduler/agenda.ts`)
- `createAgenda({ db, role: 'worker' | 'producer' })` devuelve la instancia configurada con:
  - `backend` según las decisiones técnicas.
  - `processEvery: AGENDA_PROCESS_EVERY`.
  - `maxConcurrency: AGENDA_MAX_CONCURRENCY` (default 5).
  - `defaultConcurrency: 1`.
- Con `role: 'worker'` registra las definiciones (RF-6.2) y los listeners de eventos (RF-6.6).
- Con `role: 'producer'` no registra definiciones y nunca llama a `start()`.

### RF-6.2 Definiciones de jobs

| Job | Programación | `concurrency` | `lockLimit` | `lockLifetime` | Prioridad |
| --- | --- | --- | --- | --- | --- |
| `poll-prices` | `every(POLL_PRICES_CRON)` | 1 | 1 | 5 min | `high` |
| `send-notifications` | `every(SEND_NOTIFICATIONS_CRON)` | 1 | 1 | 5 min | `high` |
| `maintenance` | `every(MAINTENANCE_CRON)` (default `15 3 * * *`, 03:15 UTC) | 1 | 1 | 15 min | `low` |

- Las expresiones cron se evalúan en UTC. Si v6 acepta la opción de timezone en `every`, se pasa `'UTC'` explícito; si no, el proceso corre con `TZ=UTC`.
- **Registro idempotente:** al arrancar, el worker llama a `every()` para cada job recurrente. Reiniciar el worker N veces deja **un solo** documento recurrente por nombre (criterio E6-2). Si cambia la expresión, se actualiza la existente.
- **Limpieza de jobs recurrentes obsoletos:** al arrancar, se cancelan los documentos recurrentes cuyo nombre ya no está en `JOB_NAMES`.

### RF-6.3 Lease lock para `poll-prices`
Módulo `src/lib/lease-lock.ts`:

```ts
acquire(name: string, owner: string, ttlMs: number): Promise<boolean>
renew(name: string, owner: string, ttlMs: number): Promise<boolean>
release(name: string, owner: string): Promise<void>
```

- `acquire`:
  - `findOneAndUpdate({ _id: name, $or: [{ lockedUntil: { $lt: now } }, { lockedBy: owner }] }, { $set: { lockedBy: owner, lockedUntil: now + ttl, acquiredAt: now } }, { upsert: true })`.
  - Si falla con `E11000`, otro dueño tiene el lock vigente: devuelve `false`.
- `release`: `deleteOne({ _id: name, lockedBy: owner })`. Nunca libera un lock ajeno.
- El handler de `poll-prices`:
  1. Hace `acquire` con TTL = `POLL_LOCK_TTL_MS` (default 5 min).
  2. Si no lo consigue, registra un `JobRun` `skipped` con `skipReason: locked` y termina **sin error**.
  3. Si lo consigue, ejecuta la lógica y hace `release` en un `finally`.
- El script manual `job:poll-prices` usa el mismo lease. Esto resuelve la limitación de la etapa 1: si el worker está corriendo el job, el manual se saltea.
- `send-notifications` **no** necesita lease: el claim atómico de la etapa 5 ya evita envíos duplicados. Se documenta por qué.
- Se eliminan los guards `isRunning` en memoria.

### RF-6.4 Adaptadores de handlers
- `poll-prices`:
  1. `trigger` es `data.trigger ?? 'agenda'`.
  2. Ejecuta la lógica de la etapa 1 y la etapa 5.
  3. Si el resultado es `failed`, **lanza** `JobFailedError(code, message)`, para que Agenda registre la falla (`failCount`, `failReason`). El `JobRun` ya quedó registrado antes de lanzar.
  4. `skipped` y `partial` **no** lanzan.
- `send-notifications`: ejecuta la lógica de la etapa 5. Solo lanza ante un error de infraestructura (base caída). Los fallos de SMTP individuales se manejan en el outbox y no hacen fallar el job.
- `maintenance` (nuevo), con pasos independientes (si uno falla, se loguea y sigue el siguiente) y su propio `JobRun`:
  1. Marca como `STALE` los `job_runs` colgados (lo mismo que al arrancar en la etapa 1).
  2. Cancela en `agenda_jobs` los jobs **únicos** (no recurrentes) terminados hace más de `AGENDA_ONE_OFF_RETENTION_DAYS` (default 7).
  3. Loguea en `warn` si en las últimas 24 h hubo notificaciones `failed` (con la cantidad).
  4. Loguea en `warn` si `poll-prices` está `stale` (la misma regla de `/status`).
- Los adaptadores reciben las dependencias por closure (fábrica), no las importan.

### RF-6.5 Política de reintentos
- Agenda 6.2.6 no documenta reintentos automáticos. Se implementan en el listener `fail:poll-prices`:
  - Si el error es transitorio (`COINGECKO_UNAVAILABLE`, `COINGECKO_RATE_LIMITED`, `ALERT_EVALUATION_FAILED`) y `data.attempt < POLL_MAX_JOB_RETRIES + 1` (default 1 reintento), programa `schedule('in 2 minutes', 'poll-prices', { trigger: 'retry', attempt: attempt + 1, parentJobId })`.
  - Errores no transitorios (`COINGECKO_AUTH`, `INTERNAL`) no se reintentan.
  - El reintento no se programa si faltan menos de 3 minutos para el próximo run recurrente (se consulta `nextRunAt` del recurrente).
- Si la versión instalada de Agenda ofrece reintentos o backoff nativos, se evalúa reemplazar esta lógica y la decisión se documenta.
- `send-notifications` y `maintenance` no se reintentan: la próxima ejecución programada cumple ese rol.

### RF-6.6 Observabilidad de eventos
- `start` y `success` → `debug`, con `jobName` y `agendaJobId`.
- `fail` → `error`, con `jobName`, `agendaJobId`, `error.code` y stack (el stack va al log, no a `failReason`).
- Contadores en memoria por job (`started`, `succeeded`, `failed`), expuestos en el log periódico del worker cada 10 minutos (`info`).

### RF-6.7 Entrypoint del worker
1. Config, DB, `ensureCollections()` y verificación de replica set (igual que antes).
2. `createAgenda({ role: 'worker' })`, registro de definiciones y `every()`.
3. Limpieza de jobs recurrentes obsoletos.
4. `await agenda.start()`.
5. Si `POLL_PRICES_RUN_ON_START=true`, `agenda.now('poll-prices', { trigger: 'startup' })`. Como pasa por el lease, si otro worker ya lo está corriendo se saltea.
6. **Apagado:**
   1. `agenda.drain(WORKER_SHUTDOWN_TIMEOUT_MS)`.
   2. Si `result.timedOut`, loguea en `warn` cuántos quedaron y llama a `agenda.stop()` para liberar sus locks.
   3. Cierra la DB y sale.

### RF-6.8 Modo de scheduler (opcional, para comparar)
- `SCHEDULER=agenda` (default) \| `cron`.
- Con `cron`, el worker usa la implementación de la etapa 1 (node-cron), manteniendo lease y outbox.
- Si no se implementa este modo, se elimina node-cron de las dependencias.

### RF-6.9 Endpoints de admin de jobs
Todos con `requireAuth({ checkRevoked: true })` + `requireRole('admin')`. La API usa la instancia productora.

**`GET /api/v1/admin/jobs`**
- Lista los jobs **recurrentes** con `name`, `schedule` (intervalo o cron), `nextRunAt`, `lastRunAt`, `lastFinishedAt`, `failCount`, `failReason`, `failedAt`, `lockedAt`, `disabled`, y el último `JobRun` de ese nombre (`status`, `finishedAt`).
- Query `includeOneOff=true` agrega los únicos de las últimas 24 h.

**`POST /api/v1/admin/jobs/:name/run`**
- `name` debe estar en `JOB_NAMES`. Si no, 404.
- Hace `agenda.now(name, { trigger: 'api', requestedBy: userId })`.
- **202 Accepted**: `{ "data": { "agendaJobId": "...", "name": "poll-prices", "queuedAt": "..." } }`.
- Si el job está deshabilitado, 409.
- Rate limit específico: 1 request cada 30 s por job, para cuidar la cuota de CoinGecko.

**`POST /api/v1/admin/jobs/:name/disable`** y **`/enable`**
- `agenda.disable({ name })` / `agenda.enable({ name })`.
- 200 con el estado resultante.
- Un job deshabilitado no se ejecuta aunque venza su `nextRunAt`.

**`GET /api/v1/status`**
- Se extiende con `pollPrices.nextRunAt` y `pollPrices.disabled`.

## 8. Requerimientos no funcionales

- **RNF-6.1:** con 2 workers corriendo, `poll-prices` se ejecuta una sola vez por intervalo (lo que se registre como skip por lease es aceptable) y cada notificación se envía una sola vez.
- **RNF-6.2:** después de `kill -9` a un worker durante `poll-prices`, otro worker (o el mismo reiniciado) vuelve a ejecutar el job como máximo en `lockLifetime` + `processEvery` + TTL del lease.
- **RNF-6.3:** la colección `agenda_jobs` no crece sin límite (limpieza de `maintenance`).
- **RNF-6.4:** con 1 worker ocioso, la carga sobre Mongo no supera 1 consulta cada `processEvery` por parte de Agenda, más los jobs propios.
- **RNF-6.5:** el arranque del worker con Agenda tarda menos de 5 s.

## 9. Variables de entorno nuevas

| Variable | Default |
| --- | --- |
| `SCHEDULER` | `agenda` |
| `AGENDA_PROCESS_EVERY` | `10 seconds` |
| `AGENDA_MAX_CONCURRENCY` | 5 |
| `AGENDA_ONE_OFF_RETENTION_DAYS` | 7 |
| `MAINTENANCE_CRON` | `15 3 * * *` |
| `POLL_LOCK_TTL_MS` | 300000 |
| `POLL_MAX_JOB_RETRIES` | 1 |

`POLL_PRICES_CRON`, `SEND_NOTIFICATIONS_CRON` y `WORKER_SHUTDOWN_TIMEOUT_MS` se mantienen.

## 10. Casos borde

- **Cambio de `POLL_PRICES_CRON` con un worker viejo todavía corriendo:** el último en llamar a `every()` define la programación. Se documenta que durante un deploy puede haber un intervalo con la programación vieja.
- **Job único `now()` mientras el recurrente corre en otro worker:** el lease hace que uno de los dos se saltee (`skipped: locked`).
- **Worker muere con el lease tomado:** el lease vence a los 5 minutos y el siguiente run lo adquiere.
- **`lockLifetime` menor que la duración real del job:** otro worker podría tomarlo en paralelo. El lease lo impide para `poll-prices`, y el `lockLifetime` de 5 minutos sobra para los tiempos esperados (< 5 s).
- **Reloj desfasado entre workers:** el lease usa la hora de cada worker. Se documenta que los relojes deben estar sincronizados (en plataformas gestionadas lo están).
- **Job deshabilitado desde la API y worker reiniciado:** `every()` no debe volver a habilitarlo (se verifica, criterio E6-9).
- **`drain` supera el timeout de apagado de la plataforma:** la plataforma mata el proceso. El lease y `lockLifetime` recuperan el trabajo.

## 11. Criterios de aceptación

- **E6-1:** DADO que el worker arranca con la base vacía, ENTONCES `agenda_jobs` contiene exactamente 3 jobs recurrentes: `poll-prices`, `send-notifications` y `maintenance`.
- **E6-2:** DADO que reinicio el worker 3 veces, ENTONCES sigue habiendo exactamente 1 documento recurrente por nombre.
- **E6-3:** DADO `POLL_PRICES_CRON` cambiado a `*/15 * * * *` y el worker reiniciado, ENTONCES el `nextRunAt` de `poll-prices` corresponde al nuevo intervalo.
- **E6-4:** DADO que el lease de `poll-prices` está tomado por otro dueño, CUANDO se ejecuta el job, ENTONCES se registra `skipped` con `skipReason: locked` y no se llama a CoinGecko.
- **E6-5:** DADO un lease vencido, CUANDO se ejecuta el job, ENTONCES adquiere el lease y corre normalmente.
- **E6-6:** DADOS 2 workers durante 30 minutos con intervalo de 10 minutos, ENTONCES hay 3 `JobRun` de `poll-prices` en `success` (más posibles `skipped: locked`) y ningún par de runs `success` superpuestos en el tiempo.
- **E6-7:** DADO que CoinGecko falla con 503 en todos los intentos, ENTONCES el job queda con `failCount` incrementado, se programa 1 reintento a 2 minutos con `trigger: retry` y `attempt: 2`, y no se programa un tercero.
- **E6-8:** DADO un error `COINGECKO_AUTH`, ENTONCES no se programa ningún reintento.
- **E6-9:** DADO que un admin deshabilita `poll-prices` y se reinicia el worker, ENTONCES el job sigue deshabilitado y no se ejecuta.
- **E6-10:** DADO un admin, CUANDO llama `POST /admin/jobs/poll-prices/run`, ENTONCES recibe 202 y en menos de `processEvery` + 5 s existe un `JobRun` con `trigger: api`.
- **E6-11:** CUANDO un admin llama `POST /admin/jobs/no-existe/run`, ENTONCES recibe 404. Un usuario común recibe 403.
- **E6-12:** DADO un job `poll-prices` en curso, CUANDO el worker recibe `SIGTERM`, ENTONCES espera a que termine, el `JobRun` queda `success` y el proceso sale con 0.
- **E6-13:** DADOS jobs únicos terminados hace 10 días, CUANDO corre `maintenance`, ENTONCES se eliminan, y los recurrentes no se tocan.
- **E6-14:** DADO que la API está corriendo, ENTONCES **no** procesa jobs: un `now()` creado sin workers activos queda pendiente hasta que arranca un worker.

## 12. Testing requerido

**Unitarios**
- Lease lock contra Mongo en memoria (es corto y conviene probarlo real): adquirir libre, adquirir ocupado, adquirir vencido, re-adquirir siendo dueño, liberar ajeno (no hace nada).
- Clasificación de errores reintentables y regla de "no reintentar si el próximo run está cerca" (función pura con reloj falso).
- Adaptador de `poll-prices`: lanza solo con `failed`.

**Integración** (`MongoMemoryReplSet` + Agenda real con `processEvery` bajo, por ejemplo `'200 milliseconds'`)
- Helper `waitForJob(agenda, name, event)` que devuelve una promesa resuelta con el evento `complete:<name>` o `fail:<name>`, con timeout.
- E6-1, E6-2 y E6-3 (inicializando el worker varias veces dentro del test).
- E6-4 y E6-5.
- E6-6 simplificado: 2 instancias de Agenda en el mismo proceso de test con `workerId` distinto y `now()` disparado en ambas al mismo tiempo → un solo `success`.
- E6-7 y E6-8 con cliente CoinGecko falso.
- E6-9, E6-10, E6-11 y E6-13.
- E6-12 con un job falso lento, verificando que `drain` espera.

**Manual**
- 2 terminales con `npm run dev:worker` durante 30 minutos. Revisar `job_runs` en Compass (E6-6 real).
- `kill -9` a un worker durante un run y observar la recuperación (RNF-6.2).

## 13. Preguntas abiertas

- ¿Mantener el modo `SCHEDULER=cron` para comparar o eliminar node-cron? Por defecto se elimina, salvo que quieras la comparación.
- ¿Querés sumar Agendash como dashboard? Primero hay que verificar su compatibilidad con Agenda 6.
