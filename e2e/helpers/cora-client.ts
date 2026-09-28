import { connect, type Socket } from 'node:net';
import type { APIRequestContext } from '@playwright/test';
import { waitForState } from './api.js';

export interface ElgatoClient {
  /** Bytes the app has sent us (keepalives, key/dial events). */
  received(): Buffer;
  /** Disconnect and wait until /api/state reports `elgatoConnected: false`. */
  close(): Promise<void>;
}

/**
 * Stand in for the Elgato app's child connection, which is what flips the WebUI to the
 * Ready stage (`elgatoConnected` is set on the child server's `clientConnected`).
 *
 * A silent client is enough: the server sends keepalives but never times a client out
 * for not answering them — the only eviction is a newcomer taking over a client idle for
 * more than CLIENT_EVICTION_GRACE_MS (10 s), and a spec never opens a second one. No
 * primary (:5343) connection either: the pairing watchdog only acts while the primary has
 * a client, so a child-only session stays up.
 */
export async function connectElgato(
  request: APIRequestContext,
  baseURL: string,
  childPort: number,
): Promise<ElgatoClient> {
  const sock: Socket = connect({ port: childPort, host: '127.0.0.1' });
  const chunks: Buffer[] = [];
  sock.on('data', (chunk: Buffer) => chunks.push(chunk));
  // An error surfaces as a failed state wait below; don't let it crash the worker.
  sock.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  await waitForState(request, baseURL, (s) => s.elgatoConnected);

  return {
    received: () => Buffer.concat(chunks),
    close: async () => {
      if (!sock.destroyed) {
        await new Promise<void>((resolve) => {
          sock.once('close', () => resolve());
          sock.destroy();
        });
      }
      await waitForState(request, baseURL, (s) => !s.elgatoConnected);
    },
  };
}
