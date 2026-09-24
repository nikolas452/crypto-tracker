# Etapa 4 — Watchlists y administración de monedas

> Aplica `00-indice-y-convenciones.md`. Requiere las etapas 0 a 3.

## 1. Objetivo

Permitir que cada usuario arme su lista de monedas a seguir (watchlist) y que un admin gestione qué monedas sigue el sistema. Es la primera relación entre datos de usuario y datos del dominio, y el primer lugar donde importa que un usuario no pueda tocar datos de otro.

## 2. Contexto

Hay usuarios autenticados con rol, monedas con `latest` y un job que solo consulta las monedas activas. Las monedas solo se agregan por el seed.

## 3. Conceptos nuevos de la etapa

- **Referencing vs embedding:**
  - _Embeber_ es guardar los datos relacionados dentro del mismo documento (por ejemplo, un array de monedas dentro del usuario).
  - _Referenciar_ es guardar solo el ID y buscar el resto aparte.
  - Se elige **referenciar, con un documento por ítem**, porque la watchlist cambia seguido, los datos de la moneda ya viven en `coins` y cambian cada 10 minutos (entidad viva), y un índice único compuesto evita duplicados sin lógica extra.
- **Índice único compuesto:** índice sobre dos campos (`userId` + `coinId`) que impide que exista dos veces la misma combinación. La base garantiza la regla aunque lleguen dos requests a la vez.
- **`$lookup`:** etapa de agregación que "une" documentos de otra colección, parecido a un JOIN de SQL. Tiene costo: conviene usarlo sobre pocos documentos y con índice en el campo de unión.
- **IDOR (Insecure Direct Object Reference):** vulnerabilidad en la que un usuario accede a recursos de otro cambiando un ID en la URL. Se evita filtrando **siempre** por el usuario autenticado y nunca aceptando `userId` desde el cliente.
- **Idempotencia de métodos HTTP:** `DELETE` y `PUT` son idempotentes por definición: repetirlos deja el mismo estado. Por eso un `DELETE` de algo que ya no existe puede responder 204 sin error.
- **Borrado en cascada:** al borrar un usuario, también se borran sus datos dependientes. Mongo no lo hace solo, lo hace tu código.
- **Soft deactivation:** en lugar de borrar una moneda, se marca `isActive: false`. Así se conserva el histórico y las referencias no quedan colgando.

## 4. Alcance

**Incluye**

- Colección `watchlist_items`.
- CRUD de la watchlist del usuario.
- Endpoints de admin para alta, activación y desactivación de monedas.
- Cascada en `DELETE /me`.

**No incluye**

- Varias watchlists por usuario (una sola, implícita).
- Pedidos de usuarios para agregar monedas nuevas.
- Orden manual de los ítems (drag & drop).

## 5. Modelo de datos

### `watchlist_items`

| Campo       | Tipo           | Reglas                                                       |
| ----------- | -------------- | ------------------------------------------------------------ |
| `_id`       | ObjectId       | —                                                            |
| `userId`    | ObjectId       | Obligatorio. Referencia a `users._id`.                       |
| `coinId`    | ObjectId       | Obligatorio. Referencia a `coins._id`.                       |
| `note`      | string \| null | Máximo 200 caracteres, con trim. Se guarda como texto plano. |
| `addedAt`   | Date           | Obligatorio                                                  |
| `updatedAt` | Date           | —                                                            |

Índices:

- `{ userId: 1, coinId: 1 }` **único**.
- `{ userId: 1, addedAt: -1 }`.
- `{ coinId: 1 }`: sirve para saber cuántos usuarios siguen una moneda antes de desactivarla.

**Límite:** `WATCHLIST_MAX_ITEMS` por usuario (default 50).

## 6. Requerimientos funcionales

### RF-4.1 `GET /api/v1/me/watchlist`

- `requireAuth`.
- Query:
  - `sort`: `addedAt` (default) \| `name` \| `change24h` \| `marketCap`.
  - `order`: `asc` \| `desc`.
- Sin paginación: el límite de 50 ítems hace innecesario paginar. La decisión se documenta.
- Implementación: agregación sobre `watchlist_items`:
  1. `$match: { userId }`.
  2. `$lookup` a `coins` por `coinId`, con proyección de `coingeckoId`, `symbol`, `name`, `isActive` y `latest`.
  3. `$unwind`.
  4. `$sort` según el parámetro.
- Una moneda desactivada **se muestra** con `isActive: false` y su último `latest` conocido.
- 200:

```json
{
  "data": [
    {
      "coingeckoId": "bitcoin",
      "symbol": "btc",
      "name": "Bitcoin",
      "isActive": true,
      "note": "largo plazo",
      "addedAt": "2026-09-16T21:00:00.000Z",
      "latest": {
        "priceUsd": 64210.12,
        "change24hPct": -1.23,
        "marketCapUsd": 1265000000000,
        "capturedAt": "..."
      }
    }
  ],
  "meta": { "count": 1, "max": 50 }
}
```

- `Cache-Control: private, no-cache`: la respuesta es de un usuario y no debe quedar en cachés compartidas.

### RF-4.2 `POST /api/v1/me/watchlist`

- `requireAuth`. Body (Zod `strict`): `{ coingeckoId: string, note?: string | null }`.
- Validaciones, en orden:
  1. Forma del body: si falla, 400.
  2. La moneda existe y está activa: si no, 404 `NOT_FOUND` con el mensaje "La moneda no está disponible".
  3. Cantidad actual < `WATCHLIST_MAX_ITEMS`: si no, 422 `UNPROCESSABLE` con `details.reason: LIMIT_REACHED`.
  4. Inserción. Si falla con `E11000`, 409 `CONFLICT` ("La moneda ya está en tu watchlist").
- El paso 3 (contar y después insertar) no es atómico. Con requests concurrentes, un usuario podría quedar con 51 ítems. Se acepta y se documenta como limitación conocida. Opcional: resolverlo con un contador en `users` y un update condicional (`$inc` con filtro `count < max`).
- 201 con el ítem en el mismo formato de RF-4.1 y header `Location: /api/v1/me/watchlist/<coingeckoId>`.

### RF-4.3 `PATCH /api/v1/me/watchlist/:coingeckoId`

- `requireAuth`. Body: `{ note: string | null }`.
- Busca la moneda por `coingeckoId` (activa o no) y el ítem por `{ userId, coinId }`. Si no existe, 404.
- 200 con el ítem actualizado.

### RF-4.4 `DELETE /api/v1/me/watchlist/:coingeckoId`

- `requireAuth`.
- `deleteOne({ userId, coinId })`.
- Responde **204 aunque el ítem no existiera**. Si el `coingeckoId` no corresponde a ninguna moneda, también 204.
- Si el formato del `coingeckoId` es inválido, 400.

### RF-4.5 Aislamiento entre usuarios

- Todas las consultas de este módulo incluyen `userId: req.user._id`.
- Ningún endpoint acepta `userId` en body, query ni params.
- Los services reciben `userId` como primer parámetro explícito.

### RF-4.6 Administración de monedas

Todas las rutas usan `requireAuth({ checkRevoked: true })` + `requireRole('admin')`.

**`GET /api/v1/admin/coins`**

- Lista paginada **incluyendo las inactivas**.
- Filtro `isActive` opcional.
- Cada ítem incluye `watchersCount` (cantidad de `watchlist_items`), calculado con una agregación con `$group` sobre `watchlist_items` para las monedas de la página.

**`POST /api/v1/admin/coins`**

- Body: `{ coingeckoId }`.
- Valida contra CoinGecko con `getMarkets([id])`:
  - Si CoinGecko no la devuelve, 422 con `details.reason: UNKNOWN_COINGECKO_ID`.
  - Si CoinGecko falla, 502 `UPSTREAM_ERROR`.
- Si la moneda no existe: la crea activa con `name` y `symbol` de CoinGecko → 201.
- Si existe inactiva: la reactiva y actualiza `name` y `symbol` → 200.
- Si existe activa: 409 `CONFLICT`.
- Deja registro en logs (`info`) con el `userId` del admin.
- Nota de cuota: cada alta consume 1 llamada.

**`PATCH /api/v1/admin/coins/:coingeckoId`**

- Body: `{ isActive: boolean }`.
- Desactivar: el job deja de consultarla desde la próxima corrida. El histórico y los ítems de watchlist se conservan.
- La respuesta incluye `watchersCount`, para que el admin vea a cuántos usuarios afecta.
- 200.

No se implementa `DELETE` de monedas. Se documenta el motivo: se perdería histórico y quedarían referencias colgando.

### RF-4.7 Cascada en `DELETE /api/v1/me`

- Antes de borrar el usuario, ejecuta `watchlist_items.deleteMany({ userId })`.
- Orden: primero los dependientes y después el usuario. Si falla a mitad de camino, repetir la operación es seguro (idempotente).
- La etapa 5 agrega alertas y notificaciones a esta misma cascada.
- Se implementa como `usersService.deleteAccount(userId)`, que llama a los services de cada módulo. No se borran colecciones ajenas desde el módulo de usuarios.

### RF-4.8 La API también necesita el cliente de CoinGecko

- `COINGECKO_API_KEY` pasa a ser obligatoria también para la API, por RF-4.6.
- Se agrega el check opcional `coingecko` a `/health/ready`, **deshabilitado por defecto**: si CoinGecko se cae, la API no debería salir del balanceador.

## 7. Requerimientos no funcionales

- **RNF-4.1:** con 50 ítems, `GET /me/watchlist` responde con p95 < 50 ms en local.
- **RNF-4.2:** las consultas de watchlist usan el índice `{ userId, ... }` (se verifica con `explain`).
- **RNF-4.3:** la API nunca devuelve `userId` ni `_id` internos de `watchlist_items`. El ítem se identifica por `coingeckoId` dentro de la watchlist del usuario.
- **RNF-4.4:** la nota se devuelve tal como se guardó. No se interpreta como HTML: es responsabilidad de cualquier cliente escaparla. En la etapa 5, el email la escapa.

## 8. Variables de entorno nuevas

| Variable              | Default |
| --------------------- | ------- |
| `WATCHLIST_MAX_ITEMS` | 50      |

`COINGECKO_API_KEY` pasa a ser obligatoria en la API.

## 9. Casos borde

- Agregar una moneda inactiva: 404, aunque exista en la base.
- Moneda desactivada después de agregarla: se sigue listando con `isActive: false` y el `latest` congelado. `PATCH` y `DELETE` funcionan.
- Dos `POST` simultáneos con la misma moneda: uno 201 y otro 409.
- `coingeckoId` con mayúsculas en la URL (`/watchlist/Bitcoin`): se normaliza a minúsculas antes de validar.
- `note` con `<script>`: se guarda y se devuelve como texto. No es un problema de la API.
- Un admin desactiva su propia moneda favorita: no hay tratamiento especial.

## 10. Criterios de aceptación

- **E4-1:** DADO un usuario sin ítems, CUANDO hace `POST /me/watchlist` con `bitcoin`, ENTONCES recibe 201 y `GET /me/watchlist` lista `bitcoin` con su `latest`.
- **E4-2:** CUANDO repite el `POST` con `bitcoin`, ENTONCES recibe 409.
- **E4-3:** CUANDO hace `POST` con una moneda inexistente o inactiva, ENTONCES recibe 404.
- **E4-4:** DADO `WATCHLIST_MAX_ITEMS=2` y 2 ítems cargados, CUANDO agrega un tercero, ENTONCES recibe 422 con `reason: LIMIT_REACHED`.
- **E4-5:** DADOS los usuarios A y B, CUANDO A agrega `bitcoin`, ENTONCES la watchlist de B sigue vacía, y un `DELETE` de B sobre `bitcoin` responde 204 sin afectar a A.
- **E4-6:** CUANDO hace `DELETE /me/watchlist/bitcoin` dos veces, ENTONCES las dos respuestas son 204.
- **E4-7:** CUANDO hace `PATCH /me/watchlist/ethereum` sin tener `ethereum`, ENTONCES recibe 404.
- **E4-8:** DADO que un admin desactiva `bitcoin`, CUANDO el usuario lista su watchlist, ENTONCES `bitcoin` aparece con `isActive: false`, y la siguiente corrida del job no pide `bitcoin` a CoinGecko.
- **E4-9:** DADO un usuario con rol `user`, CUANDO llama `POST /admin/coins`, ENTONCES recibe 403.
- **E4-10:** DADO un admin y un ID que CoinGecko no reconoce, CUANDO llama `POST /admin/coins`, ENTONCES recibe 422 con `reason: UNKNOWN_COINGECKO_ID`.
- **E4-11:** DADA una moneda inactiva, CUANDO un admin hace `POST /admin/coins` con su ID, ENTONCES se reactiva y recibe 200.
- **E4-12:** DADO un usuario con 3 ítems, CUANDO hace `DELETE /me`, ENTONCES no quedan `watchlist_items` con su `userId`.
- **E4-13:** CUANDO se listan `GET /me/watchlist?sort=change24h&order=desc`, ENTONCES el orden es por `latest.change24hPct` descendente.

## 11. Testing requerido

**Unitarios**

- Service de watchlist con repositorios falsos: orden de validaciones de RF-4.2 y traducción de `E11000` a `ConflictError`.
- Service de admin de monedas con CoinGecko falso: alta, reactivación, conflicto, ID desconocido y upstream caído.

**Integración** (supertest + mongodb-memory-server + `FakeTokenVerifier`)

- E4-1 a E4-13.
- E4-5 con dos tokens falsos distintos.
- Concurrencia del `POST` duplicado con `Promise.all`: exactamente un 201 y un 409.
- Verificación de que el índice único compuesto existe.

## 12. Preguntas abiertas

- ¿Querés resolver el límite de 50 de forma estrictamente atómica (contador en `users`) o aceptás la limitación documentada? Por defecto se acepta.
