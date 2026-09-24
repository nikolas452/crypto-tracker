# Etapa 8 (opcional) — Colas con BullMQ y Redis/Valkey

> Aplica `00-indice-y-convenciones.md`. Requiere las etapas 0 a 7 y, en producción, la **opción A** de la etapa 7 (un worker que corre de forma continua). BullMQ necesita procesos consumidores siempre activos, así que no es compatible con la opción B.
>
> **Aviso de versiones:** BullMQ 6.0.0 salió el 2026-07-30 (la última relevada es la 6.3.6). Su `package.json` declara como _peers_ opcionales `ioredis`, `redis` y `pg`, lo que sugiere cambios en cómo se configura la conexión. Buena parte de la documentación y los ejemplos públicos son de la v5. **Antes de escribir la spec, leé el changelog y la guía de migración a v6.** Los nombres de API citados acá (`Queue`, `Worker`, `upsertJobScheduler`, `UnrecoverableError`, `removeOnComplete`/`removeOnFail`, `limiter`, `attempts`/`backoff`) salen de la documentación actual de BullMQ y pueden haber cambiado. Los requerimientos están escritos en términos de comportamiento para que sigan valiendo aunque cambie la API.

## 1. Objetivo

Reemplazar Agenda por un sistema de colas sobre Redis (Valkey en Render), separando el trabajo en colas especializadas con reintentos, backoff, límites de velocidad, deduplicación y visibilidad. Mongo sigue siendo la **fuente de verdad** del negocio: las colas son el **transporte** del trabajo.

## 2. Contexto

Agenda procesa `poll-prices`, `send-notifications` y `maintenance` en Mongo. El outbox de notificaciones se procesa por lotes cada minuto con un claim atómico. Hay lease lock para `poll-prices`.

## 3. Conceptos nuevos de la etapa

- **Redis / Valkey:** base de datos clave-valor en memoria, muy rápida. Valkey es un fork open source de Redis 7.2, y es lo que usa hoy Render Key Value.
- **Persistencia en Redis:** por defecto los datos viven en memoria. Con AOF (_append-only file_) se escriben también a disco. BullMQ recomienda AOF en producción.
- **Política de expulsión (`maxmemory-policy`):** qué hace Redis cuando se llena la memoria. BullMQ **exige** `noeviction` (rechazar escrituras en lugar de borrar claves), porque perder claves rompe las colas.
- **Cola / productor / consumidor:** el productor agrega jobs a la cola (`queue.add`) y los workers (consumidores) los toman y procesan. Varios workers pueden consumir la misma cola en paralelo.
- **Fan-out:** un job genera muchos jobs más chicos. Por ejemplo, un `poll-prices` genera un `evaluate-alerts` por cada moneda actualizada.
- **Job ID determinístico:** si agregás dos jobs con el mismo ID, BullMQ ignora el segundo. Sirve para deduplicar.
- **Reintentos con backoff:** BullMQ reintenta un job fallido según `attempts` y `backoff` (fijo o exponencial). Un error marcado como irrecuperable corta los reintentos.
- **Rate limiter de cola:** limita cuántos jobs por unidad de tiempo procesa la cola en total. Sirve para respetar límites del proveedor SMTP.
- **Stalled jobs:** jobs que un worker tomó pero dejó de procesar (por ejemplo, porque murió). BullMQ los detecta y los devuelve a la cola.
- **Dead-letter:** jobs que agotaron sus intentos. En BullMQ quedan en estado `failed` para revisarlos y reintentarlos a mano.
- **Outbox + relay:** el outbox en Mongo registra _qué_ hay que enviar. Un _relay_ pasa esos registros a la cola. Si Redis pierde datos, el relay vuelve a encolar lo pendiente a partir de Mongo. Por eso Mongo es la fuente de verdad.

## 4. Alcance

**Incluye**

- Redis/Valkey en local y en producción.
- Colas `prices`, `alerts`, `notifications` y `maintenance`.
- Schedulers de BullMQ.
- Fan-out de evaluación de alertas.
- Envío de notificaciones por job individual con relay desde el outbox.
- Dashboard Bull Board protegido.
- Rate limit de la API con store en Redis (opcional).
- Migración y retiro de Agenda.
- Tests contra un Redis real.

**No incluye**

- Flows (dependencias padre-hijo entre jobs), salvo que quieras explorarlos.
- OpenTelemetry (`bullmq-otel`) (opcional).
- Redis Cluster o Sentinel.

## 5. Decisiones técnicas

- Imagen local `valkey/valkey:8`, para coincidir con Render Key Value. Configuración: `--maxmemory-policy noeviction --appendonly yes --appendfsync everysec`.
- Cliente: el que la v6 de BullMQ indique como recomendado (probablemente `ioredis` 5+, o `redis`). Para los workers, aplicar la recomendación de la guía de producción sobre `maxRetriesPerRequest: null` si se usa ioredis.
- **Render Key Value:** según la documentación de Render, **las instancias gratuitas no persisten datos a disco**. Opciones:
  - Instancia paga con persistencia (recomendada).
  - Instancia gratuita, aceptando que un reinicio vacía las colas. El relay (RF-8.5) y el re-upsert de schedulers al arrancar (RF-8.2) permiten recuperarse. Documentarlo.
  - En cualquier caso, configurar `maxmemory-policy: noeviction` al crear la instancia.
- Conexión desde Render: usar la URL **interna** de Key Value, en la misma región que la API y el worker.
- Verificar la compatibilidad de BullMQ 6 con Valkey 8 en su documentación o issues antes de desplegar.
- Nombres de colas y jobs centralizados en constantes, igual que en la etapa 6.

## 6. Diseño de colas

| Cola            | Job                                    | Productor                                  | Opciones del job                                                                                 | Opciones del worker                                                        |
| --------------- | -------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `prices`        | `poll-prices`                          | Scheduler (`POLL_PRICES_CRON`), admin      | `attempts: 2`, backoff fijo de 2 min, `removeOnComplete` 24 h / 500, `removeOnFail` 7 d          | `concurrency: 1`                                                           |
| `alerts`        | `evaluate-alerts` (una moneda)         | Handler de `poll-prices`                   | `jobId: eval:<coinId>:<capturedAt epoch>`, `attempts: 3`, backoff exponencial desde 5 s          | `concurrency: 5`                                                           |
| `notifications` | `send-notification` (una notificación) | Evaluación de alertas (post-commit), relay | `jobId: notif:<notificationId>`, `attempts: NOTIFY_MAX_ATTEMPTS`, backoff exponencial desde 60 s | `concurrency: 3`, `limiter: { max: MAIL_MAX_PER_MINUTE, duration: 60000 }` |
| `maintenance`   | `maintenance`, `relay-notifications`   | Schedulers                                 | `attempts: 1`                                                                                    | `concurrency: 1`                                                           |

**Por qué varias colas:** cada tipo de trabajo tiene necesidades distintas de concurrencia, reintentos y límites. Si comparten cola, un pico de emails puede demorar la actualización de precios.

## 7. Requerimientos funcionales

### RF-8.1 Infraestructura local

- `docker-compose.yml` suma el servicio `valkey` con la configuración de las decisiones técnicas y el puerto 6379.
- `REDIS_URL` en `.env.example`.
- Al arrancar, la API y el worker hacen `PING` y leen `CONFIG GET maxmemory-policy`. Si la política no es `noeviction`:
  - En producción, `fatal` y salida con código 1.
  - En desarrollo, `warn`.
  - Si el proveedor no permite `CONFIG GET`, se loguea que no se pudo verificar y se continúa.

### RF-8.2 Schedulers

- Al arrancar el worker, se hace _upsert_ (sin duplicar) de:
  - `poll-prices` con el patrón `POLL_PRICES_CRON`.
  - `maintenance` con `MAINTENANCE_CRON`.
  - `relay-notifications` cada `RELAY_INTERVAL_MS` (default 120000).
- Se usa el mecanismo de _job schedulers_ de BullMQ (`upsertJobScheduler` en la documentación actual), que reemplaza a los "repeatable jobs".
- Formato de las expresiones cron: BullMQ acepta patrones con campo de segundos opcional. Se mantienen expresiones de 5 campos y se documenta.
- Reiniciar el worker N veces deja **un** scheduler por ID.
- Los schedulers cuyo ID ya no está en la configuración se eliminan al arrancar.
- `send-notifications` por lote deja de existir: lo reemplazan `send-notification` individual y el relay.

### RF-8.3 `poll-prices` con fan-out

1. Ejecuta la lógica de precios de las etapas 1 y 2. Registra `JobRun` igual que antes.
2. **No** evalúa alertas en el mismo job. Por cada moneda con snapshot nuevo, agrega un `evaluate-alerts` con `{ coinId, capturedAt, value }` en bloque (`addBulk` o equivalente) y con el `jobId` determinístico.
3. Si falla el encolado (Redis caído), el run queda `partial` con `error.code: ENQUEUE_FAILED`. Las alertas de esa moneda se evalúan en la corrida siguiente, porque el valor nuevo va a traer otro `capturedAt`.
4. Si el resultado es `failed`, lanza un error para que BullMQ aplique `attempts` y `backoff`. `COINGECKO_AUTH` se lanza como irrecuperable.
5. Exclusión entre workers: con `concurrency: 1` por worker y varios workers, dos `poll-prices` (uno programado y otro manual) podrían correr a la vez. Se mantiene el **lease lock** de la etapa 6. Opcionalmente, se reemplaza por la concurrencia global de la cola si BullMQ 6 la ofrece (en v5, `queue.setGlobalConcurrency`), y la decisión se documenta.

### RF-8.4 `evaluate-alerts`

- Ejecuta la evaluación de la etapa 5 **para una sola moneda**, con la misma función `decide` y la misma transacción.
- Ajuste en la transacción: **después** del commit (nunca dentro), agrega `send-notification` con `jobId: notif:<notificationId>`. Si ese `add` falla, la notificación queda `pending` en Mongo y la toma el relay.
- `stats` por evaluación: se registran en el log del job. Agregar un `JobRun` por moneda es opcional: generaría muchos documentos, así que se sugiere agregarlos a nivel `poll-prices` con un contador en Redis o simplemente con logs.
- Errores de infraestructura → reintento con backoff.

### RF-8.5 `send-notification` y relay

**`send-notification`** (una notificación):

1. Claim en Mongo por ID: `findOneAndUpdate({ _id, status: 'pending' }, { $set: { status: 'sending', lockedAt, lockedBy } })`. Si no matchea (ya enviada, cancelada o tomada por otro), termina **sin error**, porque es un duplicado inofensivo.
2. Envía con el mailer.
3. Si el envío funciona, marca `sent` (con el filtro `lockedBy`).
4. Si falla con error permanente, marca `failed` en Mongo y lanza un error irrecuperable.
5. Si falla con error transitorio, incrementa `attempts` en Mongo y vuelve el estado a `pending`. Después lanza el error para que BullMQ reintente con su backoff.
6. En el último intento (`attemptsMade + 1 >= attempts`), marca `failed` en Mongo antes de lanzar.
7. El `nextAttemptAt` de Mongo deja de controlar los tiempos. Se mantiene solo como dato informativo.

**`relay-notifications`** (cada 2 min):

1. Busca en Mongo las notificaciones `pending` con `createdAt` o `updatedAt` de hace más de 2 minutos.
2. Las encola con `jobId: notif:<id>`. Si el job ya existe en la cola, BullMQ lo ignora.
3. Recupera las `sending` colgadas (misma regla de la etapa 5).
4. Esto cubre: fallas de encolado post-commit, pérdida de datos de Redis y notificaciones anteriores a la migración.

**Consistencia de reintentos:** cuando un job se reencola por el relay con el mismo ID después de haber fallado, BullMQ podría ignorarlo si el job `failed` sigue guardado. Regla: el reintento manual del admin (RF-8.8) elimina el job fallido antes de reencolar, o usa el mecanismo de "retry" de la cola.

### RF-8.6 `maintenance`

Mismos pasos que en la etapa 6, reemplazando la limpieza de `agenda_jobs` por:

- Conteo de jobs `failed` por cola en las últimas 24 h (`warn` si es mayor que 0).
- Limpieza de jobs viejos si `removeOnComplete`/`removeOnFail` no alcanzan (con el método de limpieza de la cola).

### RF-8.7 Ciclo de vida del worker

- Un solo proceso `worker.ts` crea los 4 workers de BullMQ.
- Cada `Queue` y cada `Worker` tiene un listener de `error` que loguea en `error`. La guía de producción de BullMQ lo pide explícitamente.
- Eventos `failed` y `completed` de cada worker → logs (`warn` / `debug`) con `queue`, `jobId`, `attemptsMade` y `error.code`.
- **Apagado ordenado** ante `SIGTERM`/`SIGINT`:
  1. `close()` de todos los workers (esperan a los jobs en curso) con timeout `WORKER_SHUTDOWN_TIMEOUT_MS`.
  2. `close()` de las colas.
  3. Cierre de las conexiones de Redis.
  4. Cierre de Mongo y salida.
- Variable `WORKER_QUEUES` (default: todas) para levantar solo algunas colas por proceso. Esto permite, por ejemplo, un worker dedicado a `notifications`.

### RF-8.8 Admin y visibilidad

Con `requireAuth({ checkRevoked: true })` + `requireRole('admin')`:

- **`GET /api/v1/admin/queues`:** por cola, conteos por estado (`waiting`, `active`, `delayed`, `completed`, `failed`, `paused`) y estado de los schedulers (próxima ejecución).
- **`POST /api/v1/admin/queues/:queue/pause`** y **`/resume`**.
- **`POST /api/v1/admin/jobs/:name/run`:** conserva el contrato de la etapa 6 (202). Ahora hace `queue.add` con `jobId: manual:<name>:<minuto actual>`, así dos clics en el mismo minuto no duplican.
- **`POST /api/v1/admin/queues/notifications/retry-failed`:** reintenta los jobs `failed` de esa cola y pone en `pending` sus notificaciones en Mongo.
- **Bull Board** (`@bull-board/api` + `@bull-board/express`, 9.x) montado en `/admin/queues-ui`:
  - El dashboard se abre desde el navegador, que no puede mandar el Bearer token de Firebase. Por eso se protege con **HTTP Basic Auth** con credenciales propias (`BULL_BOARD_USER` / `BULL_BOARD_PASS`, comparadas en tiempo constante).
  - Deshabilitado por defecto en producción (`BULL_BOARD_ENABLED=false`).
  - Solo sobre HTTPS.

### RF-8.9 Rate limit de la API con Redis (opcional)

- Si `RATE_LIMIT_STORE=redis`, los limitadores de las etapas 2 y 3 usan `rate-limit-redis` (6.x). Así el límite es compartido entre varias instancias de la API.
- Si Redis no está disponible, el limitador **deja pasar** los requests (_fail open_) y loguea en `error`. La decisión se documenta: se prioriza disponibilidad sobre protección.

### RF-8.10 Migración desde Agenda

1. Desplegar el worker BullMQ con `SCHEDULER=bullmq` y el worker Agenda apagado (**nunca** los dos a la vez sobre los mismos jobs).
2. Script `npm run migrate:agenda-to-bullmq`:
   - Cancela los jobs de `agenda_jobs`.
   - Encola las notificaciones `pending` (lo mismo que hace el relay).
   - Informa el resultado.
3. Después de una semana estable, borrar la colección `agenda_jobs` y las dependencias `agenda` y `@agendajs/mongo-backend`.
4. Los endpoints de admin de la etapa 6 mantienen sus rutas y cambian su implementación. Si alguno pierde sentido (enable/disable → pause/resume), se documenta el cambio de contrato.

## 8. Requerimientos no funcionales

- **RNF-8.1:** con Redis reiniciado y vacío, en menos de `RELAY_INTERVAL_MS` + 1 min el sistema vuelve a tener schedulers activos y reencoladas todas las notificaciones `pending`.
- **RNF-8.2:** con 2 workers, ninguna notificación se envía dos veces en condiciones normales (at-least-once solo ante una caída del proceso en medio del envío).
- **RNF-8.3:** el envío nunca supera `MAIL_MAX_PER_MINUTE`, aunque haya varios workers (el limiter de la cola es global).
- **RNF-8.4:** la memoria de Redis se mantiene acotada (`removeOnComplete` y `removeOnFail` configurados). Se documenta una consulta `INFO memory` en el runbook.
- **RNF-8.5:** ningún dato sensible viaja en los datos de los jobs. `send-notification` lleva **solo** `notificationId`, y el email se lee de Mongo al procesar.
- **RNF-8.6:** una caída de Redis no tumba la API. Los endpoints que no usan colas siguen funcionando, y los de admin de colas responden 503.

## 9. Variables de entorno nuevas

| Variable                              | Default                                   | Uso                                                              |
| ------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| `REDIS_URL`                           | —                                         | Obligatoria con `SCHEDULER=bullmq`                               |
| `SCHEDULER`                           | `bullmq`                                  | Suma el valor `bullmq` a los de la etapa 6                       |
| `WORKER_QUEUES`                       | `prices,alerts,notifications,maintenance` | —                                                                |
| `RELAY_INTERVAL_MS`                   | 120000                                    | —                                                                |
| `BULL_BOARD_ENABLED`                  | `false` en prod / `true` en dev           | —                                                                |
| `BULL_BOARD_USER` / `BULL_BOARD_PASS` | —                                         | Obligatorias si el dashboard está habilitado fuera de desarrollo |
| `RATE_LIMIT_STORE`                    | `memory`                                  | `memory` \| `redis`                                              |

## 10. Casos borde

- **Redis lleno con `noeviction`:** los `add` fallan. El outbox y el relay evitan perder notificaciones. `poll-prices` queda `partial` con `ENQUEUE_FAILED`. Se alerta por logs.
- **Mensaje enviado pero el worker muere antes de marcar `sent`:** BullMQ detecta el job como _stalled_ y lo reprocesa. El claim ve `sending`, así que no reenvía. El relay lo recupera después del timeout de lock y lo reenvía: duplicado posible (at-least-once, documentado).
- **Notificación cancelada (usuario borrado) con un job ya en la cola:** el claim no matchea y el job termina sin error.
- **Alerta disparada dos veces por el mismo `capturedAt`:** el `jobId` de `evaluate-alerts` lo deduplica, y el `version` de la alerta lo protege igual.
- **Cambio de `POLL_PRICES_CRON`:** el upsert del scheduler lo actualiza al reiniciar.
- **Render Key Value gratis reiniciado:** se pierden jobs `delayed` (reintentos programados). El relay los recupera desde Mongo.

## 11. Criterios de aceptación

- **E8-1:** DADO que el worker arranca, ENTONCES existen exactamente 3 schedulers (`poll-prices`, `maintenance` y `relay-notifications`). Después de 3 reinicios siguen siendo 3.
- **E8-2:** DADO un `poll-prices` que actualiza 4 monedas, ENTONCES se encolan 4 `evaluate-alerts` con IDs distintos. Si se reencola el mismo lote, no se duplican.
- **E8-3:** DADA una alerta que se dispara, ENTONCES se crea la notificación en Mongo y, después del commit, se encola `send-notification` con `jobId: notif:<id>`.
- **E8-4:** DADO que el `add` post-commit falla, ENTONCES la notificación queda `pending` y el relay la encola en su siguiente ejecución.
- **E8-5:** DADO un error SMTP transitorio, ENTONCES BullMQ reintenta con backoff exponencial. Al agotar los intentos, el job queda `failed` y la notificación en Mongo también.
- **E8-6:** DADO un error SMTP 550, ENTONCES el job falla sin reintentos y la notificación queda `failed` con `permanent: true`.
- **E8-7:** DADAS 100 notificaciones pendientes y `MAIL_MAX_PER_MINUTE=30`, ENTONCES en el primer minuto se envían como máximo 30, aun con 2 workers.
- **E8-8:** DADO que se hace `FLUSHALL` en Redis con notificaciones pendientes, ENTONCES después de reiniciar el worker y esperar el intervalo del relay, todas se envían y los schedulers existen de nuevo.
- **E8-9:** DADO un admin, CUANDO pausa la cola `notifications`, ENTONCES no se envían mails. Al reanudarla, se envían los pendientes.
- **E8-10:** CUANDO accedo a `/admin/queues-ui` sin Basic Auth con el dashboard habilitado, ENTONCES recibo 401. Con `BULL_BOARD_ENABLED=false`, recibo 404.
- **E8-11:** DADO que Redis está caído, CUANDO pido `GET /api/v1/coins`, ENTONCES recibo 200. CUANDO pido `GET /admin/queues`, recibo 503.
- **E8-12:** DADO `SIGTERM` durante un `send-notification`, ENTONCES el mail se envía, la notificación queda `sent` y el proceso sale con 0.

## 12. Testing requerido

- **Redis real** en los tests. Los mocks de Redis no son fiables con BullMQ, que usa scripts Lua internamente.
  - Local: `@testcontainers/redis` (12.x) o el Valkey de `docker-compose`.
  - CI: un `services:` de GitHub Actions con la imagen de Valkey.
  - Si `REDIS_URL` no está disponible, la suite se saltea con `describe.skipIf`.
- **Unitarios:** clasificación de errores (irrecuperable o reintentable), armado de `jobId`, regla de último intento.
- **Integración:** E8-1 a E8-12, con `FakeMailer`, CoinGecko falso y `MongoMemoryReplSet`. Para E8-7, usar un limiter con una duración corta en el test (por ejemplo `max: 3, duration: 1000`) y medir.
- **Manual:** dashboard, `kill -9` de un worker durante un envío (stalled) y reinicio de Valkey en local.

## 13. Preguntas abiertas

- ¿Render Key Value pago con persistencia o gratis sin persistencia (confiando en el relay)?
- ¿Mantener el lease lock o usar la concurrencia global de cola, si BullMQ 6 la trae?
- ¿Querés explorar Flows de BullMQ (por ejemplo, `poll-prices` como padre de las `evaluate-alerts`) como ejercicio extra?

## 14. Fuentes

- [BullMQ — Going to production](https://docs.bullmq.io/guide/going-to-production)
- [BullMQ — Job Schedulers](https://docs.bullmq.io/guide/job-schedulers)
- [Render — Key Value](https://render.com/docs/key-value)
- [bullmq en npm](https://www.npmjs.com/package/bullmq)
