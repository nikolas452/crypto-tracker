# Etapa 7 — Deploy real en Render

> Aplica `00-indice-y-convenciones.md`. Pensada para después de la etapa 6, pero se puede hacer una primera versión apenas termina la etapa 2 y repetirla al cerrar cada etapa. Esta es la etapa con más contacto con DevOps: infraestructura como código, health checks, secretos, deploys sin corte y monitoreo.

## 1. Objetivo

Tener la API y el procesamiento de jobs corriendo en la nube, conectados a MongoDB Atlas, con:
- Configuración reproducible (`render.yaml`).
- Secretos fuera del repo.
- Deploy automático solo si pasa el CI.
- Health checks que protegen los deploys.
- Forma de saber desde afuera si el sistema está sano.

## 2. Contexto

Todo funciona en local con Docker (Mongo en replica set + Mailpit), un worker con Agenda y la API. Hay CI en GitHub Actions.

## 3. Conceptos nuevos de la etapa

- **Build vs start:**
  - *Build* instala dependencias y compila TypeScript a JavaScript (`dist/`). Corre una vez por deploy.
  - *Start* ejecuta el JavaScript compilado. Corre cada vez que arranca una instancia.
  - En producción no se usa `tsx` ni se compila al arrancar.
- **Infraestructura como código (IaC):** describir los servicios, comandos y variables en un archivo versionado (`render.yaml`, que Render llama *Blueprint*) en lugar de configurarlos a mano en un panel. Es la misma idea que Terraform o los manifiestos de Kubernetes, a menor escala.
- **Environment group:** conjunto de variables compartidas entre servicios, para no duplicar secretos.
- **Zero-downtime deploy:** la plataforma levanta la instancia nueva, espera a que el health check responda bien y recién ahí le pasa el tráfico y apaga la vieja (con `SIGTERM`, que tu apagado ordenado maneja).
- **Spin down:** en el plan gratuito, Render apaga un web service después de 15 minutos sin tráfico. El siguiente request lo vuelve a levantar, lo que tarda alrededor de 1 minuto (*cold start*).
- **Allowlist de IPs:** lista de direcciones desde las que Atlas acepta conexiones.
- **Principio de menor privilegio:** cada credencial tiene solo los permisos que necesita (por ejemplo, un usuario de Atlas con `readWrite` sobre una sola base).
- **Smoke test:** prueba rápida posterior al deploy que confirma que lo esencial responde.
- **Monitoreo sintético (uptime monitor):** servicio externo que consulta tu URL cada X minutos y te avisa si falla.

## 4. Decisión abierta: cómo corre el worker

Según la documentación de Render, **los Background Workers y los Cron Jobs no tienen instancia gratuita**. Solo los web services (y Postgres, Key Value y sitios estáticos) la tienen. Además, un web service gratuito se apaga a los 15 minutos sin tráfico, así que no puede alojar un scheduler que corra solo.

| | Opción A — Web Service + Background Worker | Opción B — Web Service gratis + disparo externo |
| --- | --- | --- |
| Costo | Worker en instancia paga (consultar precio en render.com/pricing). La API puede ser gratis o paga. | $0 |
| Cómo se disparan los jobs | Agenda en el worker, igual que en local | Un workflow programado de GitHub Actions llama cada 10 minutos a un endpoint interno de la API, que ejecuta el ciclo en el mismo proceso |
| Separación API / worker | Real | No: el ciclo corre dentro de la API |
| Confiabilidad | Alta | GitHub avisa que los workflows programados pueden demorarse en momentos de alta carga (sobre todo al inicio de cada hora), el intervalo mínimo es 5 minutos, y en repos **públicos** se deshabilitan tras 60 días sin actividad |
| Cold start | No aplica al worker | Cada disparo puede despertar la API (≈ 1 min) |
| Lo que aprendés | Workers reales, drain, varias instancias | Endpoints internos, autenticación máquina a máquina, GitHub Actions programados |

**Recomendación:** si podés pagar el worker, **A**, porque es lo que este proyecto viene a enseñar. Si no, **B** para arrancar, dejando el código listo para A (los requerimientos cubren las dos). Una alternativa intermedia es la API gratis con un worker pago en la instancia más chica.

Los requerimientos de abajo marcan **[A]**, **[B]** o nada si aplican a ambas.

## 5. Alcance

**Incluye**
- Build de producción.
- `render.yaml`.
- Configuración de Atlas.
- Variables y secretos.
- Health checks.
- Índices en producción.
- Endpoint interno **[B]**.
- Workflow de disparo **[B]**.
- Auto-deploy condicionado al CI.
- Smoke tests.
- Monitoreo externo.
- Checklist de seguridad.
- Runbook.

**No incluye**
- Dominio propio y DNS (opcional).
- Docker (se usa el runtime nativo de Node de Render; Docker queda para tu ruta de DevOps).
- Varios entornos (staging) (opcional, en preguntas abiertas).

## 6. Requerimientos funcionales

### RF-7.1 Build de producción
- `npm run build` compila con `tsc -p tsconfig.build.json` a `dist/`, excluyendo los tests.
- Comandos en Render:
  - Build: `npm ci && npm run build`.
  - Start: `node dist/server.js` (API) y `node dist/worker.js` (worker, **[A]**).
- `npm ci` instala también las `devDependencies`, que hacen falta para compilar. Opcional: `npm prune --omit=dev` al final del build.
- Versión de Node fijada en `.node-version` (por ejemplo `24.x.y`) **y** en `engines` **con tope superior**: `"node": ">=24 <25"`. Render recomienda poner siempre un tope superior; si no, un rango abierto resuelve siempre a la última versión.
- El arranque en producción no depende de `tsx`, `pino-pretty` ni otras herramientas de desarrollo. Si `pino-pretty` está en `devDependencies`, el logger no debe intentar cargarlo con `NODE_ENV=production`.

### RF-7.2 Blueprint `render.yaml`
Versionado en la raíz. Estructura mínima:

```yaml
envVarGroups:
  - name: crypto-tracker-shared
    envVars:
      - key: NODE_ENV
        value: production
      - key: MONGODB_URI
        sync: false
      - key: COINGECKO_API_KEY
        sync: false
      - key: FIREBASE_PROJECT_ID
        sync: false
      - key: FIREBASE_CLIENT_EMAIL
        sync: false
      - key: FIREBASE_PRIVATE_KEY
        sync: false
      # ... resto de variables comunes

services:
  - type: web
    name: crypto-tracker-api
    runtime: node
    region: oregon            # elegir la región más cercana a la región de Atlas
    plan: free                # o el plan pago elegido
    buildCommand: npm ci && npm run build
    startCommand: node dist/server.js
    healthCheckPath: /health/ready
    autoDeployTrigger: checksPass
    envVars:
      - fromGroup: crypto-tracker-shared
      - key: TRUST_PROXY
        value: "1"
      - key: INTERNAL_API_KEY   # solo [B]
        generateValue: true

  - type: worker              # solo [A]
    name: crypto-tracker-worker
    runtime: node
    region: oregon
    plan: <plan pago>
    buildCommand: npm ci && npm run build
    startCommand: node dist/worker.js
    autoDeployTrigger: checksPass
    envVars:
      - fromGroup: crypto-tracker-shared
      - key: SMTP_PASS
        sync: false
```

Reglas:
- Ningún secreto con `value:` en el archivo. Siempre `sync: false` (se cargan en el panel) o `generateValue: true`.
- `autoDeployTrigger: checksPass`: Render despliega solo si los checks de GitHub (el CI) pasaron en ese commit.
- La región de Render se elige cerca de la de Atlas, para bajar la latencia de cada consulta.
- Validar el archivo contra la especificación de Blueprints de Render antes de aplicarlo. Los nombres de campos citados acá salen de su documentación.

### RF-7.3 MongoDB Atlas
- Cluster M0 (gratis) en la misma región o una cercana a Render. Límites relevantes del M0 según la documentación de Atlas:
  - 0,5 GB de almacenamiento.
  - 100 operaciones por segundo.
  - 500 conexiones.
  - Máximo 50 etapas por pipeline de agregación.
  - `allowDiskUse` se ignora (los `$sort` en memoria tienen un tope de 32 MB).
  - Pausa automática tras 30 días sin conexiones.
- **Verificar en el cluster real** que se puedan crear colecciones time-series y usar transacciones. La página de límites del plan gratuito no lo aclara. Si time-series no estuviera disponible, `ensureCollections()` falla con un mensaje claro y el fallback documentado es una colección normal con índice `{ "meta.coingeckoId": 1, timestamp: -1 }`.
- **Estimación de almacenamiento:** 10 monedas × 144 puntos/día × 90 días ≈ 130.000 snapshots, muy por debajo de 0,5 GB con compresión. Agregar al README una consulta `db.stats()` para monitorearlo.
- **Usuario de base:**
  - Uno dedicado (`crypto-tracker-app`) con rol `readWrite` **solo** sobre la base `crypto_tracker`. Nunca `atlasAdmin`.
  - Contraseña generada, de 32 caracteres o más.
- **Network access:**
  - Opción simple: `0.0.0.0/0`. La seguridad recae en la credencial y en TLS. Se documenta el riesgo.
  - Opción preferida: allowlistear las IPs de salida que Render muestra para tu servicio/región, si tu plan las expone (verificar en el panel de Render).
- URI con `retryWrites=true&w=majority`.
- `maxPoolSize` explícito (por ejemplo, 10 por proceso) para no acercarse al límite de conexiones.

### RF-7.4 Configuración de producción
- Con `NODE_ENV=production`, `env.ts` exige además:
  - `MAIL_FROM` y `SMTP_*` (en el worker, o en la API **[B]**).
  - `FIREBASE_*` (sin emulador).
  - `TRUST_PROXY >= 1`.
  - `INTERNAL_API_KEY` (≥ 32 caracteres) **[B]**.
- `LOG_LEVEL=info` y logs en JSON a stdout. Render los muestra en su visor.
- `autoIndex` de Mongoose en `false` (RF-7.5).
- Variables de desarrollo **prohibidas** en producción: `FIREBASE_AUTH_EMULATOR_HOST` (ya validado en la etapa 3) y `FIREBASE_WEB_API_KEY` (solo la usan los scripts locales).

### RF-7.5 Índices y colecciones en producción
- Script `npm run db:setup`, idempotente:
  - `ensureCollections()`.
  - `Model.syncIndexes()` para cada modelo. Crea los índices que faltan y **borra los que no están en el schema**. Por eso se loguea el diff antes de aplicarlo y, con `--dry-run`, solo lo muestra.
- Se ejecuta:
  - Como `preDeployCommand` del web service, si el plan lo permite (verificar la disponibilidad de pre-deploy en tu plan).
  - Si no, a mano desde tu máquina contra la URI de producción antes de cada deploy que cambie índices (documentado en el runbook).
- Motivo: con `autoIndex` activo, Mongoose crea índices en cada arranque. En colecciones grandes eso puede bloquear o cargar la base justo durante un deploy.

### RF-7.6 Seguridad HTTP en producción
- `helmet` con HSTS (Render termina TLS y la app solo se sirve por HTTPS).
- CORS sigue deshabilitado.
- `trust proxy` = 1, verificado con un endpoint de diagnóstico **solo para admin** (`GET /api/v1/admin/debug/ip`) que devuelve `req.ip` y `req.ips`.
- Rate limits de las etapas 2 y 3 activos.
- Errores sin stack (etapa 0).

### RF-7.7 Endpoint interno **[B]**
`POST /api/v1/internal/jobs/run-cycle`

- **Autenticación:** header `X-Internal-Key`, comparado en tiempo constante con `INTERNAL_API_KEY`. Si falta o no coincide, 401. Si `INTERNAL_API_KEY` no está configurada, 404.
- **Sin** `requireAuth` de Firebase: es autenticación máquina a máquina.
- Rate limit propio: 1 request por minuto.
- **Comportamiento síncrono**, con timeout total de `RUN_CYCLE_TIMEOUT_MS` (default 60000):
  1. Ejecuta `poll-prices` a través del lease (etapa 6) con `trigger: api`.
  2. Ejecuta `send-notifications`.
  3. Si `now` cae en la ventana diaria de mantenimiento (03:00–03:20 UTC), ejecuta `maintenance`.
- **Respuestas:**
  - 200 con `{ data: { pollPrices: { status, runId, stats }, sendNotifications: { status, runId, stats } } }`.
  - 503 si el lease estaba tomado **y** no se pudo ejecutar nada.
  - 500 si `poll-prices` terminó en `failed`, para que el workflow falle y se vea en GitHub.
- La API **no** llama a `agenda.start()` en modo B. Los jobs se ejecutan llamando directamente a la lógica. Agenda sigue sirviendo como productora para los endpoints de admin, pero en modo B **nadie consume** esos jobs: los endpoints `POST /admin/jobs/:name/run` responden 409 con `reason: NO_CONSUMER` cuando `WORKER_MODE=external`.
- `WORKER_MODE`: `agenda` **[A]** \| `external` **[B]**.

### RF-7.8 Workflow de disparo **[B]**
`.github/workflows/run-cycle.yml`:

```yaml
on:
  schedule:
    - cron: "*/10 * * * *"
  workflow_dispatch: {}
jobs:
  run-cycle:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Disparar ciclo
        run: |
          curl --fail-with-body --silent --show-error \
            --max-time 150 --retry 2 --retry-delay 20 --retry-all-errors \
            -X POST "$API_URL/api/v1/internal/jobs/run-cycle" \
            -H "X-Internal-Key: $INTERNAL_API_KEY"
        env:
          API_URL: ${{ secrets.API_URL }}
          INTERNAL_API_KEY: ${{ secrets.INTERNAL_API_KEY }}
```

- `--max-time 150` cubre el cold start (≈ 1 min) más la ejecución.
- `API_URL` e `INTERNAL_API_KEY` se guardan como **secrets** del repo. El valor de la key se copia desde el panel de Render (fue generada con `generateValue`).
- **Consumo de horas gratis:** un disparo cada 10 minutos mantiene la API prácticamente siempre despierta (≈ 744 h en un mes de 31 días). Render da **750 horas gratis por mes por workspace** y, si se agotan, suspende todos los web services gratuitos hasta el mes siguiente. Por lo tanto, en B **no** puede haber otro web service gratuito activo en el mismo workspace (por ejemplo, el del gym-app). Documentarlo.
- Si el repo es público, un commit o cualquier actividad cada menos de 60 días evita que GitHub deshabilite el workflow. Documentarlo en el runbook.

### RF-7.9 Observabilidad y alertas
- **Monitor externo** (por ejemplo, UptimeRobot en plan gratuito, u otro equivalente) con dos checks:
  1. `GET /health` cada 5 minutos: alerta si falla.
  2. Monitor de palabra clave sobre `GET /api/v1/status`: alerta si el body contiene `"stale":true`.
  - En **[B]**, el monitor también despierta la API. Tenerlo en cuenta en el cálculo de horas: no suma horas si la API ya está despierta por el workflow.
- **Alerta interna:** el job `maintenance` (etapa 6) ya loguea en `warn` las notificaciones fallidas y la staleness. En Render se pueden revisar los logs filtrando por nivel.
- Opcional: `POST /api/v1/admin/notifications/test-email` como verificación post-deploy de SMTP.

### RF-7.10 Smoke test post-deploy
- Script `npm run smoke -- --url https://<api>`. Verifica:
  1. `GET /health` → 200.
  2. `GET /health/ready` → 200.
  3. `GET /api/v1/coins?limit=1` → 200 con `data.length <= 1`.
  4. `GET /api/v1/status` → 200 y `stale: false`. Si el deploy es reciente, se permite `stale: true` con una advertencia.
  5. `GET /api/v1/me` sin token → 401.
- Sale con código 1 si falla cualquier chequeo, salvo el 4 en modo advertencia.
- Opcional: un job `smoke` en GitHub Actions disparado por `deployment_status` o manualmente con `workflow_dispatch`.

### RF-7.11 Datos iniciales en producción
- `seed:coins` se ejecuta **desde tu máquina** con `MONGODB_URI` y `COINGECKO_API_KEY` de producción cargadas temporalmente en la terminal (nunca en `.env` commiteado). Los web services gratuitos no tienen shell.
- Alternativa: un admin usa `POST /api/v1/admin/coins` (etapa 4).
- Promover tu usuario a admin con `user:set-role` apuntando a la base de producción.

### RF-7.12 Runbook (`docs/runbook.md`)
Documento con, como mínimo:
- Cómo desplegar, cómo hacer rollback (Render permite volver a un deploy anterior desde el panel) y cómo rotar cada secreto: Atlas, CoinGecko, Firebase service account, SMTP, `INTERNAL_API_KEY`.
- Qué hacer si:
  - `/status` está stale.
  - Hay notificaciones `failed`.
  - Se agotó la cuota de CoinGecko.
  - Atlas se pausó por inactividad.
  - GitHub deshabilitó el workflow **[B]**.
  - Se agotaron las horas gratis de Render **[B]**.
- Cómo correr `db:setup` y `seed:coins` contra producción.
- Consultas útiles para Compass: últimos `job_runs`, notificaciones `failed` y tamaño de colecciones.

## 7. Requerimientos no funcionales

- **RNF-7.1:** ningún secreto en el repo ni en `render.yaml`. Opcional: sumar un escáner de secretos al CI (por ejemplo, gitleaks).
- **RNF-7.2:** un deploy nuevo de la API no produce errores 5xx visibles: el health check de readiness y el apagado ordenado lo garantizan. Se verifica haciendo requests en bucle durante un deploy.
- **RNF-7.3:** **[A]** un deploy del worker no pierde ni duplica jobs (drain + lease + outbox).
- **RNF-7.4:** consumo de CoinGecko en producción ≤ 5.000 llamadas/mes. Se revisa en el panel de CoinGecko al final del primer mes.
- **RNF-7.5:** p95 de `GET /api/v1/coins` < 300 ms medido desde Argentina con la API despierta. Documentar el resultado y la región elegida.
- **RNF-7.6:** credenciales con menor privilegio (usuario de Atlas limitado a una base; service account de Firebase dedicado a este proyecto).

## 8. Variables de entorno nuevas

| Variable | Dónde | Uso |
| --- | --- | --- |
| `WORKER_MODE` | API y worker | `agenda` **[A]** / `external` **[B]** |
| `INTERNAL_API_KEY` | API | Solo **[B]** |
| `RUN_CYCLE_TIMEOUT_MS` | API | Solo **[B]**. Default 60000. |
| `MONGODB_MAX_POOL_SIZE` | Ambos | Default 10 |
| `NODE_VERSION` | Render (opcional) | Tiene prioridad sobre `.node-version` |

## 9. Casos borde

- **Atlas pausado tras 30 días sin conexiones:** en **[A]** no pasa, porque el worker se conecta siempre. En **[B]** tampoco, mientras el workflow corra. Si el workflow se deshabilita, la base puede pausarse y hay que reanudarla desde Atlas.
- **Cold start en [B] + timeout del curl:** `--retry` lo cubre. El lease evita que dos ciclos se ejecuten a la vez si el primero seguía corriendo.
- **Deploy de la API en [B] durante un ciclo:** `SIGTERM` → `server.close()` espera al request en curso hasta `SHUTDOWN_TIMEOUT_MS`. Si el ciclo tarda más, se corta y el lease vence solo.
- **`syncIndexes` borra un índice creado a mano en Atlas:** por eso existe `--dry-run` y la regla de "todo índice vive en el schema".
- **Se cambia `POLL_PRICES_CRON` en el group de variables:** Render redeploya los servicios que usan el group. En **[B]**, el intervalo real lo define el workflow, no esa variable. Documentarlo.
- **Rotación de `INTERNAL_API_KEY`:** actualizar primero el secret en GitHub y después el valor en Render, o aceptar unos minutos de disparos fallidos.

## 10. Criterios de aceptación

- **E7-1:** DADO un push a `main` con el CI en rojo, ENTONCES Render **no** despliega. Con el CI en verde, despliega.
- **E7-2:** DADO un deploy terminado, CUANDO corro `npm run smoke -- --url <api>`, ENTONCES todos los chequeos pasan.
- **E7-3:** DADO un deploy de la API mientras un script hace 5 requests por segundo a `/api/v1/coins`, ENTONCES no hay respuestas 5xx.
- **E7-4 [A]:** DADO el worker desplegado, ENTONCES en Atlas aparecen `job_runs` de `poll-prices` cada 10 minutos (±1 min) durante 1 hora.
- **E7-5 [B]:** DADO el workflow habilitado, ENTONCES en 1 hora hay al menos 5 ejecuciones exitosas del workflow y los `job_runs` correspondientes con `trigger: api`.
- **E7-6 [B]:** CUANDO llamo `run-cycle` sin `X-Internal-Key` o con una key incorrecta, ENTONCES recibo 401. Con `INTERNAL_API_KEY` sin configurar, recibo 404.
- **E7-7:** DADA una alerta que se cumple en producción, ENTONCES el email llega a una casilla real en menos de 12 minutos **[A]** o dentro del siguiente ciclo del workflow **[B]**.
- **E7-8:** CUANDO busco en el repo (incluido el historial) la URI de Atlas, la API key de CoinGecko o la private key de Firebase, ENTONCES no aparecen.
- **E7-9:** DADO `GET /api/v1/admin/debug/ip` llamado por un admin, ENTONCES `req.ip` es mi IP pública y no la del proxy de Render.
- **E7-10:** DADO que detengo el worker (o deshabilito el workflow) durante 40 minutos, ENTONCES el monitor externo alerta por `stale: true`.
- **E7-11:** CUANDO arranco la API con `NODE_ENV=production` y sin `TRUST_PROXY`, ENTONCES falla al iniciar con un mensaje claro.

## 11. Testing requerido

**Unitarios**
- `env.ts` en modo producción: variables extra obligatorias y prohibidas.
- Middleware de `X-Internal-Key`: igual que el de la etapa 2, pero con otra variable.

**Integración**
- `run-cycle` **[B]** con CoinGecko y mailer falsos: respuesta 200 con los resúmenes, 500 cuando `poll-prices` falla, 503 con el lease tomado.
- `POST /admin/jobs/:name/run` con `WORKER_MODE=external` → 409 `NO_CONSUMER`.
- `db:setup --dry-run` no modifica índices.

**Post-deploy (manual o en CI)**
- E7-1 a E7-11. El smoke test queda automatizado.

## 12. Preguntas abiertas

- **¿Opción A (pagar el worker) u opción B (gratis con GitHub Actions)?**
- ¿El repo va a ser público o privado? Afecta la regla de 60 días de inactividad y los minutos disponibles de GitHub Actions.
- ¿Querés un entorno de staging (otro group de variables, otra base y otro proyecto de Firebase) o solo producción?
- ¿Dominio propio? Hace falta, en la práctica, para el `MAIL_FROM` de la etapa 5.

## 13. Fuentes

- [Render — Deploy for Free](https://render.com/docs/free)
- [Render — Blueprint YAML Reference](https://render.com/docs/blueprint-spec)
- [Render — Setting your Node.js version](https://render.com/docs/node-version)
- [MongoDB Atlas — Free Cluster Limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/)
- [GitHub Actions scheduled workflows — guía que cita la documentación oficial](https://cronuru.com/guides/github-actions-scheduled-workflows)
