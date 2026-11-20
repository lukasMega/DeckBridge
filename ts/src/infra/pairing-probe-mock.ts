/* eslint-disable sonarjs/no-hardcoded-ip -- fixture address, nothing is contacted */
// Scripted PairingProbe for reviewing the pairing wizard on any OS (DECKBRIDGE_PAIRING_MOCK).
import type { PairingProbe } from '../web/contract-pairing-route.js';

export type MockPairingScenario =
  | 'windows-wsl'
  | 'windows-none'
  | 'windows-wsl1'
  | 'mac-26'
  | 'mac-15'
  | 'mac-intel'
  | 'mac-blocked';

const SCENARIOS: readonly MockPairingScenario[] = [
  'windows-wsl',
  'windows-none',
  'windows-wsl1',
  'mac-26',
  'mac-15',
  'mac-intel',
  'mac-blocked',
];

export function isMockPairingScenario(s: string): s is MockPairingScenario {
  return (SCENARIOS as readonly string[]).includes(s);
}

type MockBase = Pick<
  PairingProbe,
  'lanIp' | 'coraPort' | 'webuiPort' | 'relayScriptPort' | 'lanReachable'
>;

const DEFAULT_BASE: MockBase = {
  lanIp: '192.168.1.20',
  coraPort: 5343,
  webuiPort: 3000,
  relayScriptPort: 44661,
  lanReachable: true,
};

function mac(
  version: string,
  arch: 'arm64' | 'x86_64',
  orbstack: boolean,
  container: boolean,
  blocked = false,
) {
  return { version, arch, orbstack, container, localNetworkBlocked: blocked };
}

/** `base` lets the caller keep the real addresses and ports around the scripted facts. */
export function mockProbe(
  scenario: MockPairingScenario,
  base: MockBase = DEFAULT_BASE,
): PairingProbe {
  const win = { platform: 'Windows' as const, mac: null, ...base };
  const osx = { platform: 'macOS' as const, wsl: null, ...base };
  switch (scenario) {
    case 'windows-wsl':
      return {
        ...win,
        wsl: {
          installed: true,
          distros: [{ name: 'Ubuntu-24.04', version: 2, isDefault: true }],
        },
      };
    case 'windows-wsl1':
      return {
        ...win,
        wsl: { installed: true, distros: [{ name: 'Ubuntu', version: 1, isDefault: true }] },
      };
    case 'windows-none':
      return { ...win, wsl: { installed: false, distros: [] } };
    case 'mac-26':
      return { ...osx, mac: mac('26.1', 'arm64', false, true) };
    case 'mac-15':
      return { ...osx, mac: mac('15.6', 'arm64', true, false) };
    case 'mac-blocked':
      return { ...osx, mac: mac('27.2', 'arm64', true, false, true) };
    case 'mac-intel':
      return { ...osx, mac: mac('15.6', 'x86_64', false, false) };
  }
}
