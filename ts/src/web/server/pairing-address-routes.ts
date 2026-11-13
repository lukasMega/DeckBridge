import type { PairingAddressDock, PairingAddressesInfo } from '../contract-pairing.js';
import { badRequest, json } from './http.js';
import {
  LOOPBACK_ALIASES,
  detectPlatform,
  isProbeableAddress,
  pairingCandidates,
  testAddress,
} from './pairing-address.js';
import { get, postJson, type Route } from './router.js';
import { bindAddr, VIRTUAL_DOCK_INDEX } from '../../shared/types.js';

export const pairingAddressRoutes: Route[] = [
  get('/api/pairing-addresses', ({ ui, virtualDeck }) => {
    const docks: PairingAddressDock[] = ui.fullState().docks.map((d) => ({
      index: d.index,
      name: d.modelName,
      primaryPort: d.primaryPort,
      running: true,
    }));
    const vd = virtualDeck.state();
    if (vd.enabled && !docks.some((d) => d.index === VIRTUAL_DOCK_INDEX)) {
      docks.push({
        index: VIRTUAL_DOCK_INDEX,
        name: 'Browser deck',
        primaryPort: vd.coraPorts.primary,
        running: false,
      });
    }
    const info: PairingAddressesInfo = {
      platform: detectPlatform(),
      suggested: LOOPBACK_ALIASES[0]!,
      candidates: pairingCandidates(),
      docks: docks.toSorted((a, b) => a.index - b.index),
      bindAddress: bindAddr(),
    };
    return json(info);
  }),
  postJson<{ ip?: unknown }>('/api/pairing-addresses/test', async (body) => {
    if (!isProbeableAddress(body.ip)) {
      return badRequest(
        "ip must be a loopback (127.x.x.x) or one of this computer's own addresses",
      );
    }
    return json(await testAddress(body.ip as string));
  }),
];
