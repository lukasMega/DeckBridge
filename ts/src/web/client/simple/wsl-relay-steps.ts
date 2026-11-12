// Checklist for the "Pair through WSL" card. Pure so tests cover it without a browser.
// DeckBridge never runs the fix commands: the user copies them into PowerShell themselves.
import type { WslRelayState, WslRelayStatus } from '../../contract-wsl-relay.js';

export type WslStepState = 'done' | 'active' | 'todo' | 'error';

export interface WslStep {
  state: WslStepState;
  title: string;
  /** One plain sentence under the title. */
  sub?: string;
  /** A command to copy, shown under `sub`. */
  command?: string;
  /** The address to type into the Stream Deck app. */
  ip?: string;
  /** Extra line when pairing is stuck; the card appends a Help link and a full stop. */
  hint?: string;
}

const TITLES = [
  'WSL is ready',
  'Relay downloaded',
  'Relay reaches DeckBridge',
  'Add this IP in the Stream Deck app',
  'Paired',
] as const;

const ADD_IP = 'In the Stream Deck app, add a Network Dock by IP address.';
/** Shown after `STUCK_MS` in `ready`; ends in "see" because the card adds the Help link. */
export const STUCK_HINT =
  'Still not paired? Check that you added this exact IP. If it still fails, Windows may block the connection to WSL — see';
export const STUCK_MS = 2 * 60_000;

const IP_CHANGED = 'The IP changed after a restart. Remove the old Network Dock and add this IP.';

/** Index of the step each state is on; the steps before it are done, the ones after wait. */
const AT: Record<WslRelayState, { step: number; failed?: boolean }> = {
  off: { step: -1 },
  checking: { step: 0 },
  'no-wsl': { step: 0, failed: true },
  wsl1: { step: 0, failed: true },
  mirrored: { step: 0, failed: true },
  'old-glibc': { step: 0, failed: true },
  downloading: { step: 1 },
  'download-failed': { step: 1, failed: true },
  starting: { step: 2 },
  blocked: { step: 2, failed: true },
  error: { step: 2, failed: true },
  ready: { step: 3 },
  paired: { step: TITLES.length },
};

const FIXED_SUB: Partial<Record<WslRelayState, string>> = {
  checking: 'Checking WSL…',
  'no-wsl': 'WSL is not installed. Run this in PowerShell as administrator, then restart the PC.',
  wsl1: "Your Linux runs as WSL 1, which shares this PC's address. Switch it to WSL 2:",
  mirrored:
    "WSL shares this PC's address (mirrored networking). Switch it to NAT in .wslconfig, then run:",
  'old-glibc': 'Your Linux is too old. Install Ubuntu 24.04 and make it the default:',
  downloading: 'Downloading the relay (first time only)…',
  starting: 'Starting the relay…',
  blocked:
    'Windows Firewall blocks the relay. Run this in PowerShell as administrator, then press Check again:',
};

const DOWNLOAD_FAILED =
  'The download failed. Check your internet connection, then press Check again.';
const RELAY_STOPPED = 'The relay stopped unexpectedly. Press Check again.';

/** What the user sees under the current step. Fixed text where the server's `detail` is
 *  too technical for a Windows user; `detail` only where it carries the real cause. */
function subFor(s: WslRelayStatus): string | undefined {
  if (s.state === 'download-failed') return s.detail ?? DOWNLOAD_FAILED;
  if (s.state === 'error') return s.detail ?? RELAY_STOPPED;
  if (s.state === 'ready') return s.ipChanged ? IP_CHANGED : ADD_IP;
  return FIXED_SUB[s.state];
}

/** The five steps for a status. Only the current step carries a sentence and a command.
 *  `stuck` (the card's timer) adds the hint to step 4 while it is waiting for the pairing. */
export function wslRelaySteps(s: WslRelayStatus, stuck = false): WslStep[] {
  const at = AT[s.state];
  const sub = subFor(s);
  return TITLES.map((title, i): WslStep => {
    if (i < at.step)
      return { state: 'done', title, ...(i === 3 && s.wslIp ? { ip: s.wslIp } : {}) };
    if (i > at.step) return { state: 'todo', title };
    return {
      state: at.failed ? 'error' : 'active',
      title,
      ...(sub === undefined ? {} : { sub }),
      ...(at.failed && s.fixCommand ? { command: s.fixCommand } : {}),
      ...(i === 3 && s.wslIp ? { ip: s.wslIp } : {}),
      ...(i === 3 && stuck && s.state === 'ready' ? { hint: STUCK_HINT } : {}),
    };
  });
}

/** True when a step failed, so the card offers "Check again". */
export function wslRelayFailed(s: WslRelayStatus): boolean {
  return AT[s.state].failed === true;
}

/** One line for the Settings switch. */
export function wslRelayStatusLine(s: WslRelayStatus): string {
  if (!s.enabled || s.state === 'off') return 'Off';
  if (wslRelayFailed(s)) return 'Needs attention';
  if (s.state === 'paired') return s.wslIp ? `Paired · ${s.wslIp}` : 'Paired';
  if (s.state === 'ready') return `Ready · add ${s.wslIp ?? 'the IP'} in the Stream Deck app`;
  return subFor(s) ?? 'Working…';
}
