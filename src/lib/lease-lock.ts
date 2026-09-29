import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * Lease lock genérico sobre la colección `job_locks`: un mutex distribuido de
 * una sola escritura atómica por recurso (spec lease-lock), usado por
 * `poll-prices` y por el script de ejecución manual para que un documento
 * recurrente y uno puntual (o dos workers) nunca corran en simultáneo — algo
 * que la concurrencia propia de Agenda no cubre, porque esta limita cuántos
 * jobs de un mismo NOMBRE procesa una instancia, no cuántos DOCUMENTOS con
 * ese nombre existen a la vez.
 *
 * Requiere que los relojes de los workers estén razonablemente sincronizados
 * (por ejemplo vía NTP): `acquire`/`renew` comparan `lockedUntil` contra el
 * `now` de quien llama, así que un desfasaje grande entre relojes podría
 * dejar que dos owners se crean dueños del lease al mismo tiempo.
 */

const jobLockSchema = new Schema(
  {
    _id: { type: String, required: true },
    lockedBy: { type: String, required: true },
    lockedUntil: { type: Date, required: true },
    acquiredAt: { type: Date, required: true },
  },
  { collection: 'job_locks', versionKey: false },
);

export type JobLockDocument = HydratedDocument<InferSchemaType<typeof jobLockSchema>>;

export const JobLockModel = model('JobLock', jobLockSchema);

/** `true` cuando `error` es el error de clave duplicada de MongoDB (E11000) — mismo chequeo que `users.service.ts`. */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}

/**
 * Adquiere (o renueva, si `owner` ya es el dueño) el lease `name` por
 * `ttlMs` a partir de `now`. Es un único `findOneAndUpdate` atómico
 * filtrado en `{ _id: name, $or: [{ lockedUntil: { $lt: now } }, { lockedBy:
 * owner }] }` con `upsert: true`: si no existe documento, el upsert lo crea;
 * si existe pero está vencido o ya es del mismo owner, lo actualiza; si
 * existe, no está vencido y es de OTRO owner, el filtro no matchea nada y el
 * intento de upsert choca contra el `_id` ya existente con un E11000, que acá
 * se traduce en `false` en lugar de propagarse.
 */
export async function acquire(
  name: string,
  owner: string,
  ttlMs: number,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    await JobLockModel.findOneAndUpdate(
      { _id: name, $or: [{ lockedUntil: { $lt: now } }, { lockedBy: owner }] },
      { $set: { lockedBy: owner, lockedUntil: new Date(now.getTime() + ttlMs), acquiredAt: now } },
      { upsert: true, returnDocument: 'after' },
    ).exec();
    return true;
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * Extiende el lease `name` por `ttlMs` a partir de `now`, solo si `owner` ya
 * es su dueño actual. Devuelve `false` sin crear nada si no hay lease o si
 * pertenece a otro owner — a diferencia de `acquire`, `renew` nunca hace
 * upsert.
 */
export async function renew(
  name: string,
  owner: string,
  ttlMs: number,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await JobLockModel.findOneAndUpdate(
    { _id: name, lockedBy: owner },
    { $set: { lockedUntil: new Date(now.getTime() + ttlMs) } },
    { returnDocument: 'after' },
  ).exec();
  return updated !== null;
}

/**
 * Libera el lease `name` únicamente si `owner` es su dueño actual
 * (`deleteOne({ _id: name, lockedBy: owner })`). Liberar el lease de otro
 * owner sería exactamente el bug que este mecanismo existe para evitar: un
 * proceso lento que termina después de que su lease ya venció borraría el
 * lease que un worker distinto ya adquirió legítimamente, y los dos
 * quedarían corriendo en paralelo.
 */
export async function release(name: string, owner: string): Promise<void> {
  await JobLockModel.deleteOne({ _id: name, lockedBy: owner }).exec();
}
