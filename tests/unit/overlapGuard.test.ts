import { describe, expect, it, vi } from 'vitest';
import { createOverlapGuard } from '../../src/lib/overlapGuard.js';

describe('createOverlapGuard', () => {
  // E1-10
  it('E1-10: a concurrent invocation is skipped (onOverlap) while the first is still in progress', async () => {
    let resolveFirstRun: (value: string) => void;
    const firstRunPromise = new Promise<string>((resolve) => {
      resolveFirstRun = resolve;
    });
    const run = vi.fn(async () => firstRunPromise);
    const onOverlap = vi.fn();

    const guard = createOverlapGuard({ run, onOverlap });

    const call1 = guard.runGuarded('schedule');
    expect(guard.isRunning()).toBe(true);

    const call2Result = await guard.runGuarded('schedule');

    expect(call2Result).toBeUndefined();
    expect(onOverlap).toHaveBeenCalledTimes(1);
    expect(onOverlap).toHaveBeenCalledWith('schedule');
    expect(run).toHaveBeenCalledTimes(1);

    resolveFirstRun!('done');
    const call1Result = await call1;

    expect(call1Result).toBe('done');
    expect(guard.isRunning()).toBe(false);
    expect(guard.currentRun()).toBeNull();
  });

  it('releases the flag in a finally even when run() rejects', async () => {
    const run = vi.fn().mockRejectedValue(new Error('boom'));
    const onOverlap = vi.fn();
    const guard = createOverlapGuard({ run, onOverlap });

    await expect(guard.runGuarded('manual')).rejects.toThrow('boom');

    expect(guard.isRunning()).toBe(false);
    expect(guard.currentRun()).toBeNull();
  });

  it('allows a new run once the previous one has finished', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    const onOverlap = vi.fn();
    const guard = createOverlapGuard({ run, onOverlap });

    await guard.runGuarded('startup');
    await guard.runGuarded('schedule');

    expect(run).toHaveBeenCalledTimes(2);
    expect(onOverlap).not.toHaveBeenCalled();
  });
});
