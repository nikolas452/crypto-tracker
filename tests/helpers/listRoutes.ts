/**
 * Helper de tests que enumera todas las rutas (método + ruta completa)
 * registradas en una app de Express 5, incluyendo los routers anidados
 * montados con prefijo (`app.use('/api/v1/coins', ..., createCoinsRouter())`).
 *
 * Por qué no alcanza con recorrer `app.router.stack`: en Express 5 (paquete
 * `router` 2.x) cada `Layer` compila su ruta con `path-to-regexp` v8 y solo
 * conserva funciones `matchers`; el string del prefijo con el que se montó un
 * router NO se guarda en ningún campo. Las rutas hoja sí conservan su string
 * (`layer.route.path`), pero los prefijos se pierden.
 *
 * Método elegido: recorrido de la pila + captura de prefijos al registrar.
 * Mientras se construye la app, se envuelve `Router.prototype.use` para marcar
 * cada layer recién creado con el string de montaje original; después se
 * recorre la pila de forma recursiva uniendo prefijo + ruta hoja. El wrapper se
 * restaura siempre (bloque `finally`), así que no hay efecto fuera de la
 * construcción de la app.
 *
 * Las rutas se devuelven con parámetros en formato OpenAPI (`{coingeckoId}`).
 */
import { Router, type Express } from 'express';

export interface RouteEntry {
  /** Método HTTP en mayúsculas (`GET`, `POST`, ...). `ALL` si la ruta usa `router.all`. */
  readonly method: string;
  /** Ruta completa con parámetros en formato OpenAPI, por ejemplo `/api/v1/coins/{coingeckoId}`. */
  readonly path: string;
}

/** Marca interna donde se guarda el string de montaje de un layer creado con `use`. */
const MOUNT_PATHS = Symbol('mountPaths');

interface RouteLike {
  readonly path: string | readonly string[];
  readonly methods: Readonly<Record<string, boolean>>;
}

interface LayerLike {
  readonly route?: RouteLike;
  readonly handle?: { readonly stack?: readonly LayerLike[] };
  [MOUNT_PATHS]?: readonly string[];
}

interface RouterLike {
  readonly stack: LayerLike[];
}

type UseFn = (this: RouterLike, ...args: unknown[]) => unknown;

/** Convierte `:param` en `{param}` para que coincida con la notación de OpenAPI. */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** Une segmentos de ruta normalizando barras duplicadas y quitando la barra final (salvo la raíz). */
function joinPaths(prefix: string, path: string): string {
  const joined = `/${prefix}/${path}`.replace(/\/+/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

function asStringList(value: unknown, context: string): readonly string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value as string[];
  }
  throw new Error(`listRoutes: ruta no soportada (${context}); solo se admiten strings`);
}

/**
 * Determina el string de montaje de una llamada a `use(...)`, replicando la
 * lógica de `router`: si el primer argumento no es una función (ni un arreglo
 * de funciones), es el path; de lo contrario el path es `/`.
 */
function mountPathOf(args: readonly unknown[]): readonly string[] {
  let first: unknown = args[0];
  while (Array.isArray(first) && first.length > 0) {
    first = first[0];
  }
  if (typeof first === 'function') {
    return ['/'];
  }
  return asStringList(args[0], 'path de use()');
}

function walk(stack: readonly LayerLike[], prefixes: readonly string[], out: RouteEntry[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const localPaths = asStringList(layer.route.path, 'path de ruta');
      for (const method of Object.keys(layer.route.methods)) {
        for (const prefix of prefixes) {
          for (const local of localPaths) {
            out.push({
              method: method === '_all' ? 'ALL' : method.toUpperCase(),
              path: toOpenApiPath(joinPaths(prefix, local)),
            });
          }
        }
      }
      continue;
    }

    const child = layer.handle?.stack;
    if (child) {
      const mounts = layer[MOUNT_PATHS];
      if (!mounts) {
        throw new Error(
          'listRoutes: router montado sin prefijo registrado (¿se construyó fuera de listRoutes?)',
        );
      }
      const nested = prefixes.flatMap((prefix) => mounts.map((mount) => joinPaths(prefix, mount)));
      walk(child, nested, out);
    }
  }
}

/**
 * Construye una app con `buildApp` y devuelve todas sus rutas ordenadas por
 * ruta y método. `buildApp` debe crear la app dentro de la llamada (por
 * ejemplo `() => createApp({ ... })`) para que los prefijos se capturen.
 */
export function listRoutes(buildApp: () => Express): RouteEntry[] {
  const proto = Router.prototype as unknown as { use: UseFn };
  const originalUse = proto.use;

  proto.use = function patchedUse(this: RouterLike, ...args: unknown[]): unknown {
    const before = this.stack.length;
    const result = originalUse.apply(this, args);
    const mounts = mountPathOf(args);
    for (const layer of this.stack.slice(before)) {
      layer[MOUNT_PATHS] = mounts;
    }
    return result;
  };

  let app: Express;
  try {
    app = buildApp();
  } finally {
    proto.use = originalUse;
  }

  const out: RouteEntry[] = [];
  walk((app.router as unknown as RouterLike).stack, ['/'], out);

  return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}
