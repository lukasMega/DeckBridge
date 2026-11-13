// Pure parsers for the pairing probe (issue #257): `wsl.exe -l -v` rows and `sw_vers`.
// No I/O, so every branch is unit-tested without WSL or a Mac.
import type { PairingProbe } from '../web/contract-pairing-route.js';

type WslInfo = NonNullable<PairingProbe['wsl']>;

const NO_WSL: WslInfo = { installed: false, distros: [] };

/** Input is the decoded `wsl.exe -l -v` text. No table (WSL absent, or the localized "no
 *  installed distributions" message) means not installed. */
export function parseWslList(text: string): WslInfo {
  const distros: WslInfo['distros'] = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    // Rows look like `* Ubuntu-24.04  Running  2`. The header is localized, so a row is
    // recognised by its last token (the version), not by header text.
    const trimmed = line.trim();
    const isDefault = trimmed.startsWith('*');
    const t = (isDefault ? trimmed.slice(1).trim() : trimmed).split(/\s+/);
    const version = t[t.length - 1];
    if (t.length < 3 || (version !== '1' && version !== '2')) continue;
    // Docker Desktop's internal distros can't host the relay, so they must never count as "WSL ready".
    if (t[0]!.startsWith('docker-desktop')) continue;
    distros.push({ name: t[0]!, version: version === '1' ? 1 : 2, isDefault });
  }
  return distros.length === 0 ? { ...NO_WSL } : { installed: true, distros };
}

/** `sw_vers -productVersion` output to `'26.1'`; empty when unreadable. */
export function parseMacVersion(swVers: string): string {
  const m = /^\d+(?:\.\d+){0,2}/.exec(swVers.trim());
  return m ? m[0] : '';
}

export function macOsAtLeast(version: string, major: number): boolean {
  const m = /^(\d+)/.exec(version);
  return m !== null && Number(m[1]) >= major;
}
