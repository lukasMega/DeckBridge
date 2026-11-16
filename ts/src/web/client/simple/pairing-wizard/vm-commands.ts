// Copy-paste commands for the OrbStack route. The Linux steps live in a script DeckBridge serves
// (web/server/relay-script.ts), so the pasted line stays short. Pure, so the strings are tested.
import type { PairingProbe } from '../../ui-types.js';

export const ORBSTACK_MACHINE = 'deckbridge-relay';

export interface OrbstackCommands {
  create: string;
  run: string;
  ip: string;
}

/** `install` is the server's token-carrying `curl "<url>" | sh`; it holds no single quote, so it
 *  nests in `sh -c '…'`. `null` while the probe or the command is missing, or without a LAN IP. */
export function orbstackCommands(
  probe: PairingProbe | null,
  install: string | null,
): OrbstackCommands | null {
  if (probe?.mac == null || probe.lanIp === '' || install === null) return null;
  return {
    create: `orb create ubuntu:noble ${ORBSTACK_MACHINE}`,
    run: `orb -m ${ORBSTACK_MACHINE} sh -c '${install}'`,
    ip: `orb -m ${ORBSTACK_MACHINE} hostname -I`,
  };
}
