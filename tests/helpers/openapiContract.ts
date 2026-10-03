/**
 * Validadores puros del contrato OpenAPI para los tests de contrato: dado un
 * documento (en memoria, nunca un archivo commiteado), comprueban que una
 * respuesta real de la API cumple lo que la operación documenta (status, cuerpo
 * y headers declarados) y que las rutas servidas por la app y las operaciones
 * documentadas coinciden en ambos sentidos. Al ser funciones puras que reciben
 * el documento, los tests de "deriva" pueden aplicarlas a una copia mutada del
 * documento y comprobar que detectan el cambio.
 *
 * Validación de cuerpos: se desreferencian los `$ref` locales de la respuesta
 * (resolución propia, síncrona) y se compila el esquema con Ajv. Antes de
 * compilar, el esquema se vuelve estricto: un objeto con `properties` que no
 * declara `additionalProperties` pasa a prohibir campos no documentados (y los
 * `allOf` de objetos se fusionan para que eso sea posible). Así un campo
 * agregado o renombrado en el código sin actualizar la anotación también falla,
 * no solo uno que desaparece. Solo se compilan esquemas de RESPUESTA: los de
 * petición usan construcciones de OpenAPI 3.0 que Ajv no admite tal cual.
 */
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { RouteEntry } from './listRoutes.js';

export type JsonObject = Record<string, unknown>;

/** Operación identificada por método HTTP y ruta en formato OpenAPI (`/api/v1/coins/{coingeckoId}`). */
export interface OperationRef {
  readonly method: string;
  readonly path: string;
}

/** Resultado de una validación: `errors` vacío significa que la respuesta cumple el contrato. */
export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/** Rutas sin documentar y operaciones documentadas que ninguna ruta sirve. */
export interface CoverageGaps {
  readonly undocumented: readonly string[];
  readonly orphaned: readonly string[];
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

type AddFormats = (ajv: Ajv) => Ajv;
// En NodeNext el import por defecto de un paquete CommonJS puede ser el objeto
// del módulo (con `.default`) o la función misma, según el cargador.
const addFormats = ((addFormatsModule as unknown as { default?: AddFormats }).default ??
  addFormatsModule) as unknown as AddFormats;

const ajv = addFormats(new Ajv({ strict: false, allErrors: true }));

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function operationKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

// --- Cobertura de rutas ---

/** Lista las operaciones (método + ruta) que declara el documento. */
export function documentedOperations(doc: object): OperationRef[] {
  const operations: OperationRef[] = [];
  for (const [path, item] of Object.entries(
    isObject((doc as { paths?: unknown }).paths) ? (doc as { paths: JsonObject }).paths : {},
  )) {
    if (!isObject(item)) continue;
    for (const method of HTTP_METHODS) {
      if (method in item) {
        operations.push({ method: method.toUpperCase(), path });
      }
    }
  }
  return operations;
}

/** Devuelve la operación del documento con todos sus `$ref` resueltos, o `undefined` si no existe. */
export function dereferenceOperation(doc: object, operation: OperationRef): JsonObject | undefined {
  const paths = (doc as { paths?: unknown }).paths;
  const item = isObject(paths) ? paths[operation.path] : undefined;
  const node = isObject(item) ? item[operation.method.toLowerCase()] : undefined;
  if (!isObject(node)) {
    return undefined;
  }
  const resolved = dereference(doc, node);
  return isObject(resolved) ? resolved : undefined;
}

/**
 * Compara en ambos sentidos las rutas que sirve la app con las operaciones del
 * documento: `undocumented` son rutas servidas sin operación documentada y
 * `orphaned` son operaciones documentadas que ninguna ruta sirve.
 */
export function findCoverageGaps(doc: object, routes: readonly RouteEntry[]): CoverageGaps {
  const served = new Set(routes.map((route) => operationKey(route.method, route.path)));
  const documented = new Set(
    documentedOperations(doc).map((operation) => operationKey(operation.method, operation.path)),
  );

  return {
    undocumented: [...served].filter((key) => !documented.has(key)).sort(),
    orphaned: [...documented].filter((key) => !served.has(key)).sort(),
  };
}

/** Mensaje legible de los huecos de cobertura, con método y ruta de cada ofensor (vacío si no hay). */
export function formatCoverageGaps(gaps: CoverageGaps): string {
  const lines: string[] = [];
  if (gaps.undocumented.length > 0) {
    lines.push(
      `Rutas servidas sin operación documentada:\n  - ${gaps.undocumented.join('\n  - ')}`,
    );
  }
  if (gaps.orphaned.length > 0) {
    lines.push(`Operaciones documentadas sin ruta servida:\n  - ${gaps.orphaned.join('\n  - ')}`);
  }
  return lines.join('\n');
}

// --- Resolución de $ref y esquemas estrictos ---

function resolvePointer(doc: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) {
    throw new Error(`$ref no local no soportado: ${ref}`);
  }
  let current: unknown = doc;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = decodeURIComponent(rawSegment).replaceAll('~1', '/').replaceAll('~0', '~');
    if (!isObject(current) || !(segment in current)) {
      throw new Error(`$ref sin resolver: ${ref}`);
    }
    current = current[segment];
  }
  return current;
}

/** Copia profunda de `node` con cada `$ref` local reemplazado por su destino. */
function dereference(doc: unknown, node: unknown, stack: readonly string[] = []): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => dereference(doc, item, stack));
  }
  if (!isObject(node)) {
    return node;
  }
  const ref = node['$ref'];
  if (typeof ref === 'string') {
    if (stack.includes(ref)) {
      throw new Error(`$ref circular: ${ref}`);
    }
    return dereference(doc, resolvePointer(doc, ref), [...stack, ref]);
  }
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, dereference(doc, value, stack)]),
  );
}

/** Fusiona `allOf` de objetos en un único esquema (propiedades y `required` unidos). */
function flattenAllOf(schema: JsonObject): JsonObject {
  const members = schema['allOf'];
  if (!Array.isArray(members)) {
    return schema;
  }
  const { allOf: _allOf, ...own } = schema;
  let merged: JsonObject = { ...own };
  for (const member of members) {
    if (!isObject(member)) continue;
    const flat = flattenAllOf(member);
    const properties = {
      ...(isObject(flat['properties']) ? flat['properties'] : {}),
      ...(isObject(merged['properties']) ? merged['properties'] : {}),
    };
    const required = [
      ...new Set([
        ...(Array.isArray(flat['required']) ? (flat['required'] as string[]) : []),
        ...(Array.isArray(merged['required']) ? (merged['required'] as string[]) : []),
      ]),
    ];
    merged = { ...flat, ...merged, properties, required };
  }
  return merged;
}

/** Hace estricto un esquema: los objetos con `properties` y sin `additionalProperties` rechazan campos extra. */
function toStrictSchema(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => toStrictSchema(item));
  }
  if (!isObject(node)) {
    return node;
  }

  const schema = flattenAllOf(node);
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && isObject(value)) {
      result[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, toStrictSchema(child)]),
      );
    } else if (
      key === 'items' ||
      key === 'oneOf' ||
      key === 'anyOf' ||
      key === 'additionalProperties'
    ) {
      result[key] = toStrictSchema(value);
    } else {
      result[key] = value;
    }
  }
  if (isObject(result['properties']) && result['additionalProperties'] === undefined) {
    result['additionalProperties'] = false;
  }
  return result;
}

// --- Validación de respuestas ---

interface PreparedResponse {
  readonly response: JsonObject;
  readonly validate: ValidateFunction | undefined;
}

const preparedByDocument = new WeakMap<object, Map<string, PreparedResponse>>();

function describeAjvError(error: ErrorObject): string {
  let location = error.instancePath === '' ? '(raíz)' : error.instancePath;
  if (error.keyword === 'required') {
    location = `${error.instancePath}/${String(error.params['missingProperty'])}`;
  } else if (error.keyword === 'additionalProperties') {
    location = `${error.instancePath}/${String(error.params['additionalProperty'])}`;
  }
  return `${location}: ${error.message ?? error.keyword}`;
}

function prepareResponse(
  doc: object,
  operation: OperationRef,
  status: number,
): PreparedResponse | string {
  const label = `${operationKey(operation.method, operation.path)} -> ${status}`;
  const cache = preparedByDocument.get(doc) ?? new Map<string, PreparedResponse>();
  preparedByDocument.set(doc, cache);

  const cacheKey = `${label}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const paths = (doc as { paths?: unknown }).paths;
  const pathItem = isObject(paths) ? paths[operation.path] : undefined;
  const operationNode = isObject(pathItem) ? pathItem[operation.method.toLowerCase()] : undefined;
  if (!isObject(operationNode)) {
    return `${operationKey(operation.method, operation.path)}: operación no documentada`;
  }

  const responses = isObject(operationNode['responses']) ? operationNode['responses'] : {};
  const rawResponse = responses[String(status)] ?? responses['default'];
  if (rawResponse === undefined) {
    return `${label}: el status no está documentado (documentados: ${Object.keys(responses).join(', ') || 'ninguno'})`;
  }

  const response = dereference(doc, rawResponse);
  if (!isObject(response)) {
    return `${label}: la respuesta documentada no es un objeto`;
  }

  const content = isObject(response['content']) ? response['content'] : undefined;
  const media =
    content && isObject(content['application/json']) ? content['application/json'] : undefined;
  const schema = media?.['schema'];
  const validate = schema === undefined ? undefined : ajv.compile(toStrictSchema(schema) as object);

  const prepared: PreparedResponse = { response, validate };
  cache.set(cacheKey, prepared);
  return prepared;
}

/** Comprueba un valor de header contra el esquema que declara la respuesta (enum, patrón, tipo). */
function checkHeaderValue(name: string, schema: unknown, value: string): string | undefined {
  if (!isObject(schema)) {
    return undefined;
  }
  const allowed = schema['enum'];
  if (Array.isArray(allowed) && !allowed.includes(value)) {
    return `header '${name}' vale '${value}' y debería ser uno de: ${allowed.join(' | ')}`;
  }
  const pattern = schema['pattern'];
  if (typeof pattern === 'string' && !new RegExp(pattern).test(value)) {
    return `header '${name}' vale '${value}' y no cumple el patrón ${pattern}`;
  }
  if (schema['type'] === 'integer' && !/^\d+$/.test(value)) {
    return `header '${name}' vale '${value}' y debería ser un entero`;
  }
  if (schema['type'] === 'string' && value.length === 0) {
    return `header '${name}' está vacío`;
  }
  return undefined;
}

/**
 * Valida una respuesta real contra la operación documentada: el status debe
 * estar declarado, el cuerpo debe cumplir el esquema de ese status (o estar
 * ausente si la respuesta no declara contenido) y cada header declarado debe
 * estar presente y conforme a su esquema. `body` es `undefined` cuando la
 * respuesta no tiene cuerpo. Los headers no declarados no se exigen.
 */
export function validateResponse(
  doc: object,
  operation: OperationRef,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string | string[] | undefined>> = {},
): ValidationResult {
  const label = `${operationKey(operation.method, operation.path)} -> ${status}`;
  const prepared = prepareResponse(doc, operation, status);
  if (typeof prepared === 'string') {
    return { ok: false, errors: [prepared] };
  }

  const errors: string[] = [];
  const lowerHeaders = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );

  if (prepared.validate === undefined) {
    if (body !== undefined) {
      errors.push(`${label}: la respuesta no declara cuerpo pero se recibió uno`);
    }
  } else if (body === undefined) {
    errors.push(`${label}: la respuesta declara cuerpo JSON pero llegó vacía`);
  } else if (!prepared.validate(body)) {
    for (const error of prepared.validate.errors ?? []) {
      errors.push(`${label}: cuerpo ${describeAjvError(error)}`);
    }
  }

  const declaredHeaders = isObject(prepared.response['headers'])
    ? prepared.response['headers']
    : {};
  for (const [name, definition] of Object.entries(declaredHeaders)) {
    const raw = lowerHeaders[name.toLowerCase()];
    if (raw === undefined) {
      errors.push(`${label}: falta el header declarado '${name}'`);
      continue;
    }
    const value = Array.isArray(raw) ? raw.join(', ') : raw;
    const problem = checkHeaderValue(
      name,
      isObject(definition) ? definition['schema'] : undefined,
      value,
    );
    if (problem) {
      errors.push(`${label}: ${problem}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Valida un valor contra un esquema nombrado del documento (por ejemplo `#/components/schemas/Error`). */
export function validateAgainstSchemaRef(
  doc: object,
  ref: string,
  value: unknown,
): ValidationResult {
  const cache = preparedByDocument.get(doc) ?? new Map<string, PreparedResponse>();
  preparedByDocument.set(doc, cache);

  const cacheKey = `schema:${ref}`;
  let prepared = cache.get(cacheKey);
  if (!prepared) {
    const schema = dereference(doc, { $ref: ref });
    prepared = { response: {}, validate: ajv.compile(toStrictSchema(schema) as object) };
    cache.set(cacheKey, prepared);
  }

  const validate = prepared.validate;
  if (validate === undefined || validate(value)) {
    return { ok: true, errors: [] };
  }
  return {
    ok: false,
    errors: (validate.errors ?? []).map((error) => `${ref}: ${describeAjvError(error)}`),
  };
}

/** Sustituye `{param}` en una ruta de OpenAPI por los valores dados (codificados para URL). */
export function expandPath(
  template: string,
  params: Readonly<Record<string, string>> = {},
): string {
  return template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`expandPath: falta el parámetro '${name}' para ${template}`);
    }
    return encodeURIComponent(value);
  });
}
