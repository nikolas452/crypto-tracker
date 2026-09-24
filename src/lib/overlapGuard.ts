/**
 * Guarda de solapamiento genérica en memoria: como máximo una ejecución de
 * `run` a la vez. Si llega una nueva invocación mientras la anterior sigue en
 * curso, se ejecuta `onOverlap` en su lugar y la nueva invocación se omite
 * por completo.
 *
 * Deliberadamente agnóstica del scheduler y del job: `worker.ts` es el único
 * caller (RF-1.5 / design.md — "la protección contra solapamiento es un flag
 * en memoria en worker.ts, no un lock en la DB, ni responsabilidad del job").
 * Se mantiene en `src/lib/` para poder testearla en forma aislada, sin
 * levantar cron ni Mongo.
 */
export interface OverlapGuardDeps<TTrigger, TResult> {
  readonly run: (trigger: TTrigger) => Promise<TResult>;
  readonly onOverlap: (trigger: TTrigger) => Promise<void> | void;
}

export interface OverlapGuard<TTrigger, TResult> {
  /**
   * Ejecuta `run(trigger)` a menos que una invocación anterior siga en
   * curso — en cuyo caso se ejecuta `onOverlap(trigger)` en su lugar y esta
   * llamada resuelve a `undefined` sin llegar a llamar a `run`. El flag "en
   * curso" se libera en un `finally`, para que una ejecución que lance o
   * rechace no lo deje trabado.
   */
  runGuarded(trigger: TTrigger): Promise<TResult | undefined>;
  isRunning(): boolean;
  /** La promesa de la ejecución en curso, o `null` cuando está inactiva. */
  currentRun(): Promise<TResult> | null;
}

export function createOverlapGuard<TTrigger, TResult>(
  deps: OverlapGuardDeps<TTrigger, TResult>,
): OverlapGuard<TTrigger, TResult> {
  let running = false;
  let current: Promise<TResult> | null = null;

  return {
    isRunning: () => running,
    currentRun: () => current,
    async runGuarded(trigger) {
      if (running) {
        await deps.onOverlap(trigger);
        return undefined;
      }

      running = true;
      const runPromise = deps.run(trigger).finally(() => {
        running = false;
        current = null;
      });
      current = runPromise;
      return runPromise;
    },
  };
}
