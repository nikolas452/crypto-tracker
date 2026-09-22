import os from 'node:os';

/** `hostname-pid` — identifies which process executed a given `JobRun`. */
export function createWorkerId(): string {
  return `${os.hostname()}-${process.pid}`;
}
