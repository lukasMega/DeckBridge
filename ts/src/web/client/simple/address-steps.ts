// Per-OS text for the pairing-address helper. Pure so tests cover it without a browser.
// DeckBridge never runs these commands: the user copies them into a terminal themselves.
import type { PairingPlatform } from '../../contract-pairing.js';

export type OsTab = 'macos' | 'linux' | 'windows';

export const OS_TABS: ReadonlyArray<{ id: OsTab; label: string }> = [
  { id: 'macos', label: 'macOS' },
  { id: 'linux', label: 'Linux' },
  { id: 'windows', label: 'Windows' },
];

export interface AddressSteps {
  /** Absent when there is nothing to run. */
  command?: string;
  undo?: string;
  /** Plain-language lines shown under the command. */
  notes: string[];
  /** True until the steps were run on that OS; the modal says so. */
  unverified: boolean;
}

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function isIpv4(ip: string): boolean {
  return IPV4.test(ip);
}

export function isLoopbackIp(ip: string): boolean {
  return isIpv4(ip) && ip.startsWith('127.');
}

export function defaultTab(platform: PairingPlatform): OsTab {
  if (platform === 'macos' || platform === 'windows') return platform;
  return 'linux';
}

const LAN_NOTE = 'This is an address of this computer already. Nothing to run.';
const BAD_IP_NOTE = 'Pick a valid IPv4 address first.';

/** Commands to make `ip` exist on this computer. Only loopback aliases ever need one. */
export function addressSteps(os: OsTab, ip: string): AddressSteps {
  if (!isIpv4(ip)) return { notes: [BAD_IP_NOTE], unverified: false };
  if (!isLoopbackIp(ip)) return { notes: [LAN_NOTE], unverified: false };
  if (ip === '127.0.0.1') {
    return {
      notes: ['127.0.0.1 is the main loopback address. Nothing to run.'],
      unverified: false,
    };
  }
  if (os === 'macos') {
    return {
      command: `sudo ifconfig lo0 alias ${ip} up`,
      undo: `sudo ifconfig lo0 -alias ${ip}`,
      notes: ['Run it once in Terminal. It does not survive a reboot, so run it again after one.'],
      unverified: false,
    };
  }
  if (os === 'linux') {
    return {
      command: `sudo ip addr add ${ip}/8 dev lo`,
      undo: `sudo ip addr del ${ip}/8 dev lo`,
      notes: [
        'Usually nothing is needed: the whole 127.0.0.0/8 range is on the loopback device. Press Test first and run this only if it fails.',
        'Not verified on Linux yet.',
      ],
      unverified: true,
    };
  }
  return {
    notes: [
      'Normally nothing to do: Windows answers on all of 127.0.0.0/8. Press Test.',
      "If the test fails, use this computer's LAN IP or a VPN adapter address instead.",
      'Not verified on Windows yet.',
    ],
    unverified: true,
  };
}

/** The value to type in the Elgato app's Add Network Device dialog. */
export function elgatoEntry(ip: string, port: number): string {
  return `${ip}:${port}`;
}
