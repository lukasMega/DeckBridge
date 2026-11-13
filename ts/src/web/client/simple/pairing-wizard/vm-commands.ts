// Copy-paste commands for the OrbStack route. The Linux steps live in a script DeckBridge serves
// (web/server/relay-script.ts), so the pasted line stays short. Pure, so the strings are tested.
import type { PairingProbe } from '../../ui-types.js';

export const ORBSTACK_MACHINE = 'deckbridge-relay';

export interface OrbstackCommands {
  create: string;
  run: string;
  ip: string;
}

/** `null` while the probe is missing or DeckBridge has no reachable LAN IP. */
export function orbstackCommands(probe: PairingProbe | null): OrbstackCommands | null {
  if (probe?.mac == null || probe.lanIp === '') return null;
  const url = `http://${probe.lanIp}:${probe.relayScriptPort}/relay.sh`;
  return {
    create: `orb create ubuntu:noble ${ORBSTACK_MACHINE}`,
    run: `orb -m ${ORBSTACK_MACHINE} sh -c 'curl -fsSL ${url} | sh'`,
    ip: `orb -m ${ORBSTACK_MACHINE} hostname -I`,
  };
}
