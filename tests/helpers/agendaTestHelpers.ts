import type { Agenda } from 'agenda';

/**
 * Helper compartido por los tests de integración del scheduler: resuelve
 * cuando Agenda emite `complete:<name>` (éxito) o `fail:<name>` (fallo) para
 * un job dado, o rechaza si ninguno de los dos ocurre dentro de `timeoutMs`.
 * Evita que cada test de `agenda-job-definitions`/`agenda-job-adapters`/
 * `job-retry-policy` tenga que repetir su propia lógica de espera por
 * eventos.
 *
 * El default de 10s (en lugar de igualar el `processEvery` bajo de estos
 * tests, ~200ms) deja margen bajo carga: correr la suite completa levanta
 * decenas de `MongoMemoryReplSet` en paralelo, y un timeout ajustado
 * ocasionalmente competía con esa contención de CPU/IO en observaciones
 * reales.
 */
/**
 * Variante multi-instancia: resuelve cuando entre todas las instancias dadas se
 * acumularon `count` eventos `complete:<name>`/`fail:<name>`. Sirve cuando cada
 * `now()` crea un job distinto y no se puede saber qué instancia lo toma.
 */
export function waitForJobCount(
  agendas: Agenda[],
  name: string,
  count: number,
  timeoutMs = 10000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let seen = 0;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${count} runs of ${name} (saw ${seen})`));
    }, timeoutMs);

    function onDone(): void {
      seen += 1;
      if (seen >= count) {
        cleanup();
        resolve();
      }
    }

    function cleanup(): void {
      clearTimeout(timer);
      for (const agenda of agendas) {
        agenda.off(`complete:${name}`, onDone);
        agenda.off(`fail:${name}`, onDone);
      }
    }

    for (const agenda of agendas) {
      agenda.on(`complete:${name}`, onDone);
      agenda.on(`fail:${name}`, onDone);
    }
  });
}

export function waitForJob(agenda: Agenda, name: string, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for complete:${name} or fail:${name}`));
    }, timeoutMs);

    function onComplete(): void {
      cleanup();
      resolve();
    }

    function onFail(): void {
      cleanup();
      resolve();
    }

    function cleanup(): void {
      clearTimeout(timer);
      agenda.off(`complete:${name}`, onComplete);
      agenda.off(`fail:${name}`, onFail);
    }

    agenda.on(`complete:${name}`, onComplete);
    agenda.on(`fail:${name}`, onFail);
  });
}
