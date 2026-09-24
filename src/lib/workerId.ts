import os from 'node:os';

/** `hostname-pid` — identifica qué proceso ejecutó un `JobRun` determinado. */
export function createWorkerId(): string {
  return `${os.hostname()}-${process.pid}`;
}
