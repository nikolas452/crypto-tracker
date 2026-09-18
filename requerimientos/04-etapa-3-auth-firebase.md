# Etapa 3 — Usuarios y autenticación con Firebase Auth

> Aplica `00-indice-y-convenciones.md`. Requiere las etapas 0 a 2.

## 1. Objetivo

Identificar a quien llama a la API, crear su perfil en Mongo la primera vez que aparece, proteger rutas por autenticación y por rol, y reemplazar la API key temporal de admin por un usuario con rol `admin`. Como no hay frontend, se agregan herramientas para obtener tokens desde la línea de comandos.

## 2. Contexto

La API de lectura es pública. Las rutas `/admin` usan `X-Admin-Key`. No existe el concepto de usuario.

## 3. Conceptos nuevos de la etapa

- **Autenticación (authN):** confirmar quién sos.
- **Autorización (authZ):** decidir qué podés hacer, una vez que se sabe quién sos.
- **Proveedor de identidad:** servicio externo que maneja registro, login, contraseñas y recuperación. Acá es Firebase Auth. Tu backend **nunca** ve ni guarda contraseñas.
- **ID token de Firebase:** un JWT (JSON Web Token) que Firebase emite al hacer login y que dura 1 hora. Tiene tres partes: header, payload (los *claims*: `uid`, `email`, `email_verified`, `exp`...) y firma. El cliente lo manda en cada request con `Authorization: Bearer <token>`.
- **Verificación del token:** `firebase-admin` comprueba la firma con las claves públicas de Google (las descarga y las cachea), que el token sea para tu proyecto (`aud`), que lo haya emitido Firebase (`iss`) y que no esté vencido (`exp`). No hace falta consultar a Firebase en cada request, salvo que se pida verificar la **revocación**, que sí hace una llamada extra.
- **Refresh token:** credencial de larga duración que el cliente usa para obtener ID tokens nuevos. El backend no la maneja.
- **Provisioning JIT (just-in-time):** crear el usuario en tu base la primera vez que llega con un token válido, en lugar de tener un endpoint de registro.
- **Upsert:** "actualizá si existe, insertá si no", en una sola operación.
- **Condición de carrera:** dos requests simultáneos del mismo usuario nuevo intentan crearlo a la vez. El índice único hace que uno falle con error de clave duplicada (`E11000`), y ese caso hay que manejarlo.
- **Service account:** credencial de servidor de Google Cloud que permite a `firebase-admin` actuar sobre tu proyecto. Es un secreto.
- **Emulador de Firebase Auth:** versión local de Firebase Auth para desarrollo y pruebas, sin tocar el proyecto real.
- **Aumento de tipos (declaration merging):** extender el tipo `Request` de Express para que TypeScript conozca `req.auth` y `req.user`.

## 4. Alcance

**Incluye**
- Inicialización de `firebase-admin`.
- Abstracción `TokenVerifier` con una implementación real y una falsa para tests.
- Middlewares `requireAuth` y `requireRole`.
- Modelo `User` con provisioning JIT.
- `GET /api/v1/me`, `PATCH /api/v1/me` y `DELETE /api/v1/me`.
- Rate limit por usuario en las rutas autenticadas.
- Migración de `/admin` a rol `admin`.
- Scripts `auth:create-test-user`, `auth:token` y `user:set-role`.
- Soporte del emulador de Firebase Auth en desarrollo.

**No incluye**
- Login o registro propios, manejo de contraseñas y OAuth social (lo hace Firebase).
- Email de notificación distinto del email de la cuenta (ver RF-3.6).
- Custom claims de Firebase para roles (el rol vive en Mongo).

## 5. Decisiones técnicas

- `firebase-admin` 14.x con la API modular: `firebase-admin/app` y `firebase-admin/auth`.
- Credenciales por variables de entorno (`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` y `FIREBASE_PRIVATE_KEY`). Así funciona igual en local y en Render, sin archivos JSON.
- Usar un **proyecto de Firebase nuevo** para esta app (por ejemplo `crypto-tracker-dev`), separado del gym-app, con el proveedor Email/Password habilitado.
- El rol es fuente de verdad en Mongo. Se descartan los custom claims para no depender de que el token se refresque cuando cambia el rol.
- `checkRevoked` es `false` por defecto y `true` solo en operaciones sensibles (`DELETE /me` y rutas de admin).

## 6. Modelo de datos

### `users`

| Campo | Tipo | Reglas |
| --- | --- | --- |
| `_id` | ObjectId | Se usa internamente como `userId` en otras colecciones |
| `firebaseUid` | string | Obligatorio, único |
| `email` | string \| null | Minúsculas. Se sincroniza desde el token. |
| `emailVerified` | boolean | Se sincroniza desde el token |
| `displayName` | string \| null | 1–50 caracteres; se aplica trim |
| `role` | enum `user` \| `admin` | Default `user` |
| `lastSeenAt` | Date | — |
| `createdAt` / `updatedAt` | Date | `timestamps: true` |

Índices: `{ firebaseUid: 1 }` único y `{ email: 1 }` no único (sirve para buscar desde los scripts).

## 7. Requerimientos funcionales

### RF-3.1 Inicialización de Firebase Admin
- `src/integrations/firebase/admin.ts` inicializa la app **una sola vez**: si `getApps()` ya tiene una, la reutiliza.
- `FIREBASE_PRIVATE_KEY` puede venir con los saltos de línea escapados (`\n` literal). Se normalizan con `replace(/\\n/g, '\n')`.
- Si `FIREBASE_AUTH_EMULATOR_HOST` está definida:
  - Se loguea en `warn` "usando emulador de Auth".
  - Solo se permite si `NODE_ENV !== 'production'`. En producción, el proceso sale con código 1.
- Si faltan credenciales y no hay emulador, la config falla al arrancar (fail fast).

### RF-3.2 `TokenVerifier`
```ts
interface TokenVerifier {
  verify(idToken: string, opts?: { checkRevoked?: boolean }): Promise<VerifiedIdentity>;
}
type VerifiedIdentity = { uid: string; email: string | null; emailVerified: boolean; name: string | null };
```
- La implementación real usa `getAuth().verifyIdToken(token, checkRevoked)` y traduce los errores:

| Error de Firebase | Error de la app |
| --- | --- |
| `auth/id-token-expired` | `UnauthenticatedError` con código `TOKEN_EXPIRED` |
| `auth/id-token-revoked` | `UnauthenticatedError` (`TOKEN_REVOKED`) |
| `auth/user-disabled` | `ForbiddenError` (`USER_DISABLED`) |
| `auth/argument-error` y otros errores de formato o firma | `UnauthenticatedError` (`UNAUTHENTICATED`) |
| Error de red al verificar revocación | `UpstreamError` (`FIREBASE_UNAVAILABLE`) |

- `FakeTokenVerifier` (solo en tests) resuelve tokens según un mapa fijo (`"token-user-1" → { uid: "u1", ... }`) y puede simular cada uno de los errores.
- El verifier se inyecta en `createApp(deps)`.

### RF-3.3 Middleware `requireAuth`
1. Lee `Authorization`. Si falta, o el esquema no es `Bearer` (sin distinguir mayúsculas), o el token está vacío → 401 `UNAUTHENTICATED`.
2. Rechaza tokens de más de 4.096 caracteres sin verificarlos → 401.
3. Verifica con `TokenVerifier`. `checkRevoked` sale de la opción del middleware: `requireAuth({ checkRevoked: true })`.
4. Guarda `req.auth = { uid, email, emailVerified }`.
5. Ejecuta el provisioning (RF-3.4) y guarda `req.user` (documento del usuario, tipado).
6. Los tokens **nunca** se aceptan por query string ni por body.
7. El token nunca se loguea. `redact` de pino cubre `req.headers.authorization`.

### RF-3.4 Provisioning JIT y sincronización
En `usersService.resolveFromIdentity(identity, now)`:
1. `findOne({ firebaseUid })`.
2. Si no existe: `findOneAndUpdate({ firebaseUid }, { $setOnInsert: { role: 'user', displayName: identity.name, ... }, $set: { email, emailVerified, lastSeenAt: now } }, { upsert: true, new: true })`.
   - Si falla con `E11000` (otro request lo creó al mismo tiempo), se reintenta **una vez** con `findOne`.
   - Se loguea en `info` "usuario creado" con el `userId`, sin el email.
3. Si existe:
   - Si `email` o `emailVerified` difieren de los del token, se actualizan.
   - Si `lastSeenAt` es anterior a `now - LAST_SEEN_THROTTLE_MIN` (default 5), se actualiza `lastSeenAt`.
   - Ambas cosas van en **un solo** `updateOne`, y solo si hace falta alguna. Motivo: no escribir en la base en cada request.
4. Devuelve el usuario.

### RF-3.5 Middleware `requireRole(...roles)`
- Se usa siempre después de `requireAuth`.
- Si `req.user.role` no está en la lista, responde 403 `FORBIDDEN`.
- Se aplica a todo `/api/v1/admin/*`: `requireAuth({ checkRevoked: true })` + `requireRole('admin')`.
- Se eliminan `requireAdminKey` y `ADMIN_API_KEY` (etapa 2).

### RF-3.6 Endpoints del usuario
Todos requieren `requireAuth`.

**`GET /api/v1/me`** → 200
```json
{ "data": { "id": "665f...", "email": "nico@example.com", "emailVerified": true, "displayName": "Nico", "role": "user", "createdAt": "..." } }
```

**`PATCH /api/v1/me`**
- Body (Zod `strict`): `{ displayName?: string | null }`. Al menos un campo. Otros campos → 400.
- 200 con el mismo formato que `GET /me`.
- El email **no** se puede cambiar desde la API: las notificaciones (etapa 5) van siempre al email verificado de la cuenta de Firebase. Motivo de seguridad: si se pudiera poner cualquier email de notificación, la app podría usarse para mandar correos a terceros.

**`DELETE /api/v1/me`**
- `requireAuth({ checkRevoked: true })`.
- Borra el documento `users` y, a partir de las etapas 4 y 5, en cascada: watchlist, alertas y notificaciones pendientes.
- Responde 204.
- **No** borra la cuenta en Firebase (ver preguntas abiertas). Si el mismo usuario vuelve a llamar con un token válido, se crea un perfil nuevo vacío. Esto se documenta.

### RF-3.7 Rate limit por usuario
- En las rutas bajo `requireAuth`, un limitador adicional usa como clave `req.auth.uid`: `USER_RATE_LIMIT_PER_MIN` (default 120) requests por minuto.
- Se registra **después** de `requireAuth` y convive con el límite global por IP.

### RF-3.8 Scripts de desarrollo (no hay frontend)

**`npm run auth:create-test-user -- --email a@b.com --password secret123 [--admin]`**
- Usa `getAuth().createUser({ email, password, emailVerified: true })`, contra el emulador o el proyecto de desarrollo.
- Con `--admin`, además crea el perfil en Mongo con `role: admin`.
- Se niega a correr si `NODE_ENV=production`.

**`npm run auth:token -- --email a@b.com --password secret123`**
- Llama a la REST API de Firebase Auth: `POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=<FIREBASE_WEB_API_KEY>` con `{ email, password, returnSecureToken: true }`.
- Con emulador, la URL es `http://<FIREBASE_AUTH_EMULATOR_HOST>/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=cualquiera`.
- Imprime **solo** el `idToken` por stdout, para poder hacer `TOKEN=$(npm run -s auth:token -- ...)`.
- Se niega a correr si `NODE_ENV=production`.

**`npm run user:set-role -- --email a@b.com --role admin`**
- Busca el usuario en Mongo por email. Si no existe, muestra el error "el usuario debe haber llamado a la API al menos una vez o haberse creado con `auth:create-test-user`".
- Actualiza el rol e imprime el cambio (antes → después).

**Emulador**
- Documentar en el README cómo levantarlo con `firebase-tools`: `firebase emulators:start --only auth`. Requiere Java instalado; verificar la versión exigida en la documentación de Firebase.
- Con `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099`, tanto `firebase-admin` como los scripts apuntan al emulador.

### RF-3.9 Tipos
- `src/types/express.d.ts` extiende `Express.Request` con `id: string`, `auth?: { uid; email; emailVerified }` y `user?: UserDoc`.
- Helper `getUser(req)` que devuelve `UserDoc` o lanza `UnauthenticatedError`, para no usar `req.user!` en los controllers.

## 8. Requerimientos no funcionales

- **RNF-3.1:** la verificación de token sin `checkRevoked` no hace llamadas de red en cada request, salvo el refresco periódico de las claves públicas que maneja la librería. p95 del middleware < 20 ms en local, después del primer request.
- **RNF-3.2:** ningún log contiene tokens, private key ni emails completos. En logs de nivel `info`, el email se enmascara (`n***@example.com`).
- **RNF-3.3:** el proceso no arranca en `production` con el emulador configurado.
- **RNF-3.4:** una ráfaga de 10 requests concurrentes de un usuario nuevo crea exactamente 1 documento en `users`.
- **RNF-3.5:** un request autenticado de un usuario existente hace a lo sumo 1 lectura y 1 escritura sobre `users`.

## 9. Variables de entorno nuevas

| Variable | Obligatoria | Uso |
| --- | --- | --- |
| `FIREBASE_PROJECT_ID` | Sí | — |
| `FIREBASE_CLIENT_EMAIL` | Sí, salvo con emulador | Del JSON del service account |
| `FIREBASE_PRIVATE_KEY` | Sí, salvo con emulador | Del JSON del service account. **Secreto.** |
| `FIREBASE_WEB_API_KEY` | Solo para `auth:token` fuera del emulador | Configuración web del proyecto |
| `FIREBASE_AUTH_EMULATOR_HOST` | No | `127.0.0.1:9099` en desarrollo |
| `USER_RATE_LIMIT_PER_MIN` | No (default 120) | — |
| `LAST_SEEN_THROTTLE_MIN` | No (default 5) | — |

Se elimina `ADMIN_API_KEY`.

## 10. Casos borde

- Token de otro proyecto de Firebase (por ejemplo, del gym-app): 401 por `aud` inválido.
- Token vencido: 401 `TOKEN_EXPIRED`. El cliente debe pedir uno nuevo.
- Usuario deshabilitado en Firebase: con `checkRevoked`, 403 `USER_DISABLED`. Sin `checkRevoked`, el token sigue siendo válido hasta que vence (máximo 1 h). Es una limitación conocida y queda documentada.
- Usuario sin email (proveedor anónimo o teléfono): `email: null`. Las alertas por email (etapa 5) le van a responder 422.
- `Authorization: Bearer` sin token, o con espacios extra: 401.
- Usuario borrado en Mongo pero vivo en Firebase: se recrea vacío en el siguiente request (comportamiento documentado).
- Rol cambiado a `user` mientras el usuario tenía un token: el cambio aplica en el siguiente request, porque el rol se lee de Mongo.

## 11. Criterios de aceptación

- **E3-1:** CUANDO llamo `GET /me` sin header `Authorization`, ENTONCES recibo 401 `UNAUTHENTICATED`.
- **E3-2:** CUANDO llamo con `Authorization: Basic xxx`, ENTONCES recibo 401.
- **E3-3:** DADO un token vencido, ENTONCES recibo 401 con `code: TOKEN_EXPIRED`.
- **E3-4:** DADO un token válido de un uid nuevo, CUANDO llamo `GET /me`, ENTONCES se crea el usuario con `role: user` y lo recibo en la respuesta.
- **E3-5:** DADO un uid nuevo, CUANDO hago 10 requests concurrentes, ENTONCES existe exactamente 1 documento en `users` y los 10 requests responden 200.
- **E3-6:** DADO un usuario con `lastSeenAt` de hace 1 minuto, CUANDO hace un request, ENTONCES `lastSeenAt` no cambia. Si es de hace 10 minutos, se actualiza.
- **E3-7:** DADO un token con `email_verified: true` y el usuario guardado con `false`, CUANDO hace un request, ENTONCES `emailVerified` pasa a `true`.
- **E3-8:** CUANDO hago `PATCH /me` con `{ "displayName": "Nico" }`, ENTONCES recibo 200 con el nombre actualizado. Con `{ "role": "admin" }`, recibo 400.
- **E3-9:** DADO un usuario con rol `user`, CUANDO llama `GET /admin/job-runs`, ENTONCES recibe 403. Con rol `admin`, recibe 200.
- **E3-10:** CUANDO llamo `GET /admin/job-runs` con el antiguo `X-Admin-Key` y sin token, ENTONCES recibo 401.
- **E3-11:** CUANDO llamo `DELETE /me`, ENTONCES recibo 204 y el documento ya no existe.
- **E3-12:** DADO `USER_RATE_LIMIT_PER_MIN=2`, CUANDO el mismo usuario hace 3 requests desde IPs distintas, ENTONCES el tercero recibe 429.
- **E3-13:** DADO `NODE_ENV=production` y `FIREBASE_AUTH_EMULATOR_HOST` definida, CUANDO arranca la API, ENTONCES sale con código 1.
- **E3-14 (manual):** con el emulador levantado, `auth:create-test-user` + `auth:token` + `curl -H "Authorization: Bearer $TOKEN" /api/v1/me` devuelve el perfil.

## 12. Testing requerido

**Unitarios**
- Traducción de errores de Firebase a errores de la app (con errores simulados que tengan el `code` correspondiente).
- `requireAuth` con `FakeTokenVerifier`: E3-1, E3-2 y E3-3, más token demasiado largo y token por query ignorado.
- `requireRole`.
- Lógica de sincronización de `resolveFromIdentity` con reloj falso: E3-6 y E3-7, verificando que no se escribe cuando no hace falta.
- Enmascarado de email.

**Integración** (supertest + mongodb-memory-server + `FakeTokenVerifier`)
- E3-4, E3-5 (con `Promise.all`), E3-8, E3-9, E3-10, E3-11 y E3-12.
- Normalización de la private key (unitario).

**Opcional:** una suite de integración contra el emulador real de Firebase Auth, marcada con `describe.skipIf(!process.env.FIREBASE_AUTH_EMULATOR_HOST)`, que cree un usuario, obtenga un token y llame a `/me`.

## 13. Preguntas abiertas

- ¿`DELETE /me` también debe borrar la cuenta en Firebase (`getAuth().deleteUser(uid)`)? Si sí, hay que definir qué pasa si Mongo se borra bien y Firebase falla. Por defecto, solo se borran los datos de la app.
- ¿Exigir `emailVerified: true` para usar la watchlist, o solo para las alertas (etapa 5)? Por defecto, solo para las alertas.
