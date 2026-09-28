import { describe, expect, it, vi } from 'vitest';
import type mongoose from 'mongoose';
import { verifyReplicaSet } from '../../src/lib/verifyReplicaSet.js';

/**
 * Tests unitarios de `verifyReplicaSet` de `src/lib/verifyReplicaSet.ts`.
 * Usa una conexión falsa con un `admin().command()` inyectado en vez de una
 * segunda instancia real de Mongo que no sea un replica set — así se
 * ejercita el camino de rechazo sin depender de infraestructura extra.
 */

function fakeConnection(helloResult: Record<string, unknown>): mongoose.Connection {
  return {
    db: {
      admin: () => ({
        command: vi.fn().mockResolvedValue(helloResult),
      }),
    },
  } as unknown as mongoose.Connection;
}

describe('verifyReplicaSet', () => {
  it('does not exit when the "hello" response includes setName', async () => {
    const connection = fakeConnection({ setName: 'rs0', ismaster: true });
    const logger = { fatal: vi.fn() };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await verifyReplicaSet(logger, connection);

    expect(logger.fatal).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('logs fatal and exits with code 1 when the "hello" response has no setName', async () => {
    const connection = fakeConnection({ ismaster: true });
    const logger = { fatal: vi.fn() };
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await verifyReplicaSet(logger, connection);

    expect(logger.fatal).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('throws when called before the Mongo connection is open', async () => {
    const connection = { db: undefined } as unknown as mongoose.Connection;
    const logger = { fatal: vi.fn() };

    await expect(verifyReplicaSet(logger, connection)).rejects.toThrow(
      'verifyReplicaSet() called before the Mongo connection is open',
    );
  });
});
