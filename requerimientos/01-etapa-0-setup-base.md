# Etapa 0 — Setup base

> Aplica todo lo definido en `00-indice-y-convenciones.md`.

## 1. Objetivo

Tener un servidor Express en TypeScript que arranque, se conecte a MongoDB, valide su configuración, responda health checks, maneje errores con un formato único y se apague ordenadamente. No incluye lógica de negocio.

## 2. Contexto

Repositorio vacío. Todo lo que se construya después (worker, endpoints, auth) se apoya en esta base.

## 3. Conceptos nuevos de la etapa

- **Proceso:** un programa en ejecución. Acá hay uno solo, el de la API. En la etapa 1 aparece un segundo proceso, el worker.
- **Endpoint:** combinación de método HTTP + ruta que el servidor sabe responder (`GET /health`).
- **Middleware:** función que Express ejecuta en cadena antes o después del handler de la ruta. Puede modificar el request, cortar la cadena o capturar errores.
- **Manejador de errores centralizado:** middleware especial de 4 parámetros `(err, req, res, next)` que recibe cualquier error lanzado en la cadena y arma la respuesta. Así, ningún handler tiene que armar respuestas de error a mano.
- **Liveness vs readiness:** *liveness* responde "el proceso está vivo" y no depende de nada externo. *Readiness* responde "estoy listo para atender", así que chequea dependencias como la base. Las plataformas de deploy usan el segundo para decidir si mandarte tráfico (esto es terreno DevOps: es lo mismo que las *probes* de Kubernetes).
- **Graceful shutdown (apagado ordenado):** cuando la plataforma quiere reiniciar tu proceso (por ejemplo, en un deploy), le manda la señal `SIGTERM`. Un apagado ordenado deja de aceptar conexiones nuevas, termina las que están en curso, cierra la base y recién ahí sale.
- **Fail fast:** si la configuración es inválida, el proceso se cae apenas arranca, con un mensaje claro, en vez de fallar más tarde de forma confusa.

## 4. Alcance

**Incluye**
- Proyecto Node 24 + TypeScript strict + ESM.
- Express 5, helmet, parseo de JSON, request id, logging de requests.
- Validación de variables de entorno con Zod.
- Conexión a Mongo con reintentos al arrancar.
- `GET /health` y `GET /health/ready`.
- Handler de rutas inexistentes (404) y manejador de errores centralizado.
- Clases de error de la app.
- Apagado ordenado.
- `docker-compose.yml` con Mongo para desarrollo.
- ESLint, Prettier, Vitest y workflow de CI.

**No incluye**
- Modelos de dominio, auth, jobs ni deploy.
- CORS: no hay frontend. CORS es un mecanismo del navegador, así que se deja **deshabilitado** (no se registra el middleware `cors`).

## 5. Requerimientos funcionales

### RF-0.1 Separación entre app y servidor
- `src/app.ts` exporta `createApp(deps)`, que devuelve la instancia de Express configurada **sin** llamar a `listen`.
- `src/server.ts` lee la config, conecta la base, llama a `createApp`, hace `listen` y registra el apagado ordenado.
- Motivo: los tests de integración usan `createApp` directamente con supertest, sin abrir un puerto.

### RF-0.2 Validación de configuración
- `src/config/env.ts` define un esquema Zod con:

| Variable | Tipo | Obligatoria | Default | Reglas |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | enum `development` \| `test` \| `production` | No | `development` | — |
| `PORT` | entero | No | `3000` | 1–65535 |
| `MONGODB_URI` | string | Sí | — | Debe empezar con `mongodb://` o `mongodb+srv://` |
| `MONGODB_DB_NAME` | string | No | `crypto_tracker` | No vacío |
| `LOG_LEVEL` | enum de niveles de pino | No | `info` | — |
| `SHUTDOWN_TIMEOUT_MS` | entero | No | `10000` | ≥ 1000 |

- Los valores numéricos llegan como string y se convierten (`z.coerce.number()`).
- Si la validación falla: se loguea en nivel `fatal` la lista de variables inválidas (nombre y motivo, **nunca el valor**) y se sale con código 1.
- Se exporta `config` como objeto de solo lectura (`Object.freeze`) y con tipos inferidos del esquema.
- La función de parseo recibe el objeto de entorno por parámetro (`parseEnv(source)`) para poder testearla sin tocar `process.env`.

### RF-0.3 Conexión a MongoDB
- `connectDb(uri, dbName, logger)`:
  - Hasta 5 intentos, con espera exponencial entre intentos: 1 s, 2 s, 4 s, 8 s.
  - Cada intento fallido se loguea en `warn` con el número de intento, sin mostrar la URI.
  - Si fallan los 5, se loguea en `fatal` y el proceso sale con código 1.
- Se loguean los eventos de conexión de Mongoose: `connected` (info), `disconnected` (warn), `reconnected` (info), `error` (error).
- `disconnectDb()` cierra la conexión y se usa en el apagado.
- Mongoose con `strictQuery: true`. `autoIndex` activo en `development` y `test`, desactivado en `production` (se retoma en la etapa 7).
- El servidor **no** hace `listen` hasta que la conexión esté establecida.

### RF-0.4 Middlewares base (en este orden)
1. `requestId`: toma `X-Request-Id` del request si existe y mide ≤ 128 caracteres; si no, genera un UUID v4 con `crypto.randomUUID()`. Lo guarda en `req.id` (con tipo extendido) y lo devuelve en el header `X-Request-Id`.
2. Logger de requests (`pino-http`) usando ese `requestId`. Registra método, ruta, status y duración al terminar la respuesta. No registra body ni headers sensibles.
3. `helmet()` con la configuración por defecto.
4. `express.json({ limit: '100kb' })`. Si el JSON está mal formado, la respuesta es 400 `VALIDATION_ERROR` con el mensaje "JSON inválido" (el manejador de errores traduce el error de body-parser).
5. `app.disable('x-powered-by')`, aunque helmet ya lo quite.
6. Rutas.
7. Handler 404.
8. Manejador de errores.

### RF-0.5 `GET /health` (liveness)
- No consulta la base ni ningún servicio externo.
- Respuesta 200:
```json
{ "status": "ok", "uptimeSeconds": 123, "timestamp": "2026-09-16T21:30:00.000Z" }
```

### RF-0.6 `GET /health/ready` (readiness)
- Chequea que `mongoose.connection.readyState === 1` **y** ejecuta un `ping` a la base con un timeout de 2 s.
- Si todo está bien, responde 200:
```json
{ "status": "ready", "checks": { "mongo": "up" }, "timestamp": "..." }
```
- Si algo falla, responde 503 con el mismo formato, `"status": "not_ready"` y `"mongo": "down"`. Este endpoint es la única excepción al formato de error global, porque las plataformas leen el status code y el body describe los checks.
- Los checks se definen como una lista extensible (`{ name, check(): Promise<void> }`), para poder agregar otros en etapas siguientes.

### RF-0.7 Clases de error
En `src/lib/errors.ts`:
- `AppError` (base) con `code`, `httpStatus`, `message`, `details?` y `cause?`.
- Derivadas: `ValidationError`, `UnauthenticatedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `UnprocessableError`, `UpstreamError`, `ServiceUnavailableError`.
- Un helper `validate(schema, data, source)` que, si Zod falla, lanza `ValidationError` con `details` armados a partir de los issues (`path` con prefijo `body.`, `query.` o `params.`).

### RF-0.8 Handler 404
- Cualquier ruta sin match responde 404 `NOT_FOUND` con el mensaje `Ruta no encontrada: <MÉTODO> <path>`.

### RF-0.9 Manejador de errores centralizado
- Si el error es `AppError`, responde con su status y su código.
- Si es un error de JSON mal formado, responde 400 `VALIDATION_ERROR`.
- Si es un `CastError` de Mongoose (ID con formato inválido), responde 400 `VALIDATION_ERROR`.
- Cualquier otro error responde 500 `INTERNAL_ERROR` con el mensaje genérico "Error interno".
  - En `development` agrega `details.stack`.
  - En `production` nunca incluye stack ni el mensaje original.
- Todos los errores 5xx se loguean en `error` con `requestId`, stack y `cause`. Los 4xx se loguean en `info` o `warn`.
- Si la respuesta ya empezó a enviarse (`res.headersSent`), delega en `next(err)`.
- Se apoya en que Express 5 captura solo los rechazos de handlers `async`. **No** se usa `express-async-errors` ni wrappers.

### RF-0.10 Apagado ordenado
- Ante `SIGTERM` o `SIGINT`:
  1. Loguea "shutdown iniciado" con la señal recibida.
  2. Llama a `server.close()`: deja de aceptar conexiones y espera a que terminen las activas.
  3. Llama a `disconnectDb()`.
  4. Sale con código 0.
- Si el proceso no terminó en `SHUTDOWN_TIMEOUT_MS`, loguea en `error` y sale con código 1.
- Un segundo `SIGINT` durante el apagado fuerza la salida inmediata.
- `unhandledRejection` y `uncaughtException` se loguean en `fatal` y disparan el mismo apagado con código de salida 1.

### RF-0.11 Entorno de desarrollo
- `docker-compose.yml` con el servicio `mongo` (imagen `mongo:8`), puerto 27017 y volumen nombrado.
  - Desde la etapa 5 se cambia a replica set de un nodo. Se deja comentado cómo hacerlo.
- `.env.example` con todas las variables de RF-0.2.
- README con: requisitos, cómo levantar Mongo, cómo correr en desarrollo, cómo correr los tests.
- `.gitignore` que incluya `node_modules`, `dist`, `.env` y `coverage`.
- `package.json` con `"type": "module"`, `"engines": { "node": ">=24 <25" }` (con tope superior; Render lo recomienda porque un rango abierto resuelve siempre a la última versión) y los scripts `dev`, `build`, `start`, `typecheck`, `lint`, `format`, `test`, `test:watch` y `test:coverage`.
- `.node-version` con la versión exacta usada.

### RF-0.12 CI
- `.github/workflows/ci.yml` que en cada push y PR corre, sobre Node 24: `npm ci`, `npm run typecheck`, `npm run lint` y `npm test`.

## 6. Requerimientos no funcionales

- **RNF-0.1:** `tsconfig` con `strict: true`, `noUncheckedIndexedAccess: true`, `module` y `moduleResolution` en `NodeNext`, y `target` ES2023 o superior.
- **RNF-0.2:** en desarrollo, con la base disponible, el arranque tarda menos de 3 s.
- **RNF-0.3:** `GET /health` responde en menos de 10 ms en local.
- **RNF-0.4:** cero secretos en el código o en el historial de git.
- **RNF-0.5:** ningún archivo fuera de `config/env.ts` lee `process.env` (se valida con una regla de ESLint `no-restricted-properties` o con una búsqueda en CI).

## 7. Modelo de datos

No hay colecciones de dominio en esta etapa.

## 8. Variables de entorno nuevas

`NODE_ENV`, `PORT`, `MONGODB_URI`, `MONGODB_DB_NAME`, `LOG_LEVEL` y `SHUTDOWN_TIMEOUT_MS`.

## 9. Casos borde

- Mongo caído al arrancar: se reintenta 5 veces y se sale con código 1. El servidor nunca queda escuchando sin base.
- Mongo se cae con el servidor ya corriendo: `/health` sigue en 200, `/health/ready` pasa a 503 y los endpoints que usen la base devuelven 503 `SERVICE_UNAVAILABLE`. Mongoose reintenta la conexión solo.
- `X-Request-Id` enviado con más de 128 caracteres: se ignora y se genera uno nuevo.
- Body mayor a 100 kb: 413. El manejador lo traduce a `VALIDATION_ERROR` con status 413.
- `PORT` en uso: error `EADDRINUSE`, que se loguea en `fatal` y termina el proceso con código 1.

## 10. Criterios de aceptación

- **E0-1:** DADO que la app está corriendo, CUANDO hago `GET /health`, ENTONCES recibo 200 con `status: "ok"`, `uptimeSeconds` numérico y un header `X-Request-Id`.
- **E0-2:** DADO que Mongo está conectado, CUANDO hago `GET /health/ready`, ENTONCES recibo 200 con `checks.mongo: "up"`.
- **E0-3:** DADO que Mongo está desconectado, CUANDO hago `GET /health/ready`, ENTONCES recibo 503 con `status: "not_ready"`.
- **E0-4:** DADO cualquier request, CUANDO envío `X-Request-Id: abc-123`, ENTONCES la respuesta trae el mismo `X-Request-Id: abc-123`.
- **E0-5:** CUANDO hago `GET /no-existe`, ENTONCES recibo 404 con el formato de error global y `code: "NOT_FOUND"`.
- **E0-6:** DADO un endpoint que lanza un error no previsto y `NODE_ENV=production`, CUANDO lo llamo, ENTONCES recibo 500 `INTERNAL_ERROR` sin stack en el body, y el error queda logueado con stack.
- **E0-7:** CUANDO envío un JSON mal formado a cualquier ruta, ENTONCES recibo 400 `VALIDATION_ERROR`.
- **E0-8:** DADO que falta `MONGODB_URI`, CUANDO arranco el proceso, ENTONCES termina con código 1 y el log menciona `MONGODB_URI` sin mostrar ningún valor.
- **E0-9:** DADO que el servidor está atendiendo un request lento, CUANDO recibe `SIGTERM`, ENTONCES el request en curso termina bien y después el proceso sale con código 0.

## 11. Testing requerido

**Unitarios**
- `parseEnv`: config válida, falta `MONGODB_URI`, `PORT` no numérico, `NODE_ENV` inválido y defaults aplicados.
- `validate()`: arma bien `details` con el prefijo de origen.
- Mapeo del manejador de errores: cada `AppError` da su status y código; un `Error` genérico da 500; con `production` no hay stack.

**Integración** (supertest + mongodb-memory-server)
- E0-1 a E0-7.
- Para E0-3: desconectar Mongoose dentro del test y verificar el 503.
- Para E0-6: registrar una ruta de prueba que lance un error, solo dentro del test (pasándola por `deps` a `createApp`).

**Manual (documentado en el README)**
- E0-8 y E0-9.

## 12. Preguntas abiertas

Ninguna.
