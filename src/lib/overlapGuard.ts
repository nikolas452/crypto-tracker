/**
 * Generic in-memory overlap guard: at most one `run` at a time. If a new
 * invocation arrives while a previous one is still in progress, `onOverlap`
 * runs instead and the new invocation is skipped entirely.
 *
 * Scheduler-agnostic and job-agnostic on purpose: `worker.ts` is the only
 * caller (RF-1.5 / design.md — "overlap protection is an in-memory flag in
 * worker.ts, not a DB lock, not the job's concern"). Kept in `src/lib/` so it
 * can be unit tested in isolation, without spinning up cron or Mongo.
 */
export interface OverlapGuardDeps<TTrigger, TResult> {
  readonly run: (trigger: TTrigger) => Promise<TResult>;
  readonly onOverlap: (trigger: TTrigger) => Promise<void> | void;
}

export interface OverlapGuard<TTrigger, TResult> {
  /**
   * Runs `run(trigger)` unless a previous invocation is still in progress —
   * in which case `onOverlap(trigger)` runs instead and this call resolves
   * to `undefined` without ever calling `run`. The "in progress" flag is
   * released in a `finally`, so a thrown/rejected run can't leave it stuck.
   */
  runGuarded(trigger: TTrigger): Promise<TResult | undefined>;
  isRunning(): boolean;
  /** The currently in-progress run's promise, or `null` when idle. */
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
