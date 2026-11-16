import type { PairingRoute, PairingRouteStatus } from '../../ui-types.js';
import { isRelayRoute } from './routes.js';

export type VersionAnswer = 'new' | 'old' | 'unsure';
export interface Answers {
  version?: VersionAnswer;
  where?: 'here' | 'elsewhere';
  otherDevice?: boolean;
  route?: PairingRoute;
}
export type ScreenId =
  | 'version'
  | 'where'
  | 'why'
  | 'device'
  | 'choose'
  | 'setup'
  | 'add'
  | 'done-old'
  | 'done-elsewhere';

// wsl and downgrade end at setup: the WSL checklist already has "add IP" and "paired".
const ADD_ROUTES: ReadonlySet<PairingRoute> = new Set(['device', 'container', 'orbstack']);

/** Ordered screens for the answers so far; the last one is where the user is or may go next. */
export function screens(a: Answers): ScreenId[] {
  const out: ScreenId[] = ['version'];
  if (a.version === undefined) return out;
  if (a.version === 'old') return [...out, 'done-old'];
  out.push('where');
  if (a.where === undefined) return out;
  if (a.where === 'elsewhere') return [...out, 'done-elsewhere'];
  out.push('why', 'device');
  if (a.otherDevice === undefined) return out;
  out.push('choose');
  if (a.route === undefined || a.route === 'none') return out;
  out.push('setup');
  if (isRelayRoute(a.route) && ADD_ROUTES.has(a.route)) out.push('add');
  return out;
}

/** Parses the first 3 numeric parts ('7.6.1.23015' → [7,6,1]); null when unparsable. */
export function parseVersion(v: string | null): [number, number, number] | null {
  if (v === null) return null;
  const m = /^\s*(\d+)\.(\d+)(?:\.(\d+))?(?:\.\d+)*\s*$/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

/** true ≥ 7.6.1, false < 7.6.1, null unknown. */
export function isAffected(v: string | null): boolean | null {
  const p = parseVersion(v);
  if (!p) return null;
  const [maj, min, pat] = p;
  if (maj !== 7) return maj > 7;
  if (min !== 6) return min > 6;
  return pat >= 1;
}

/** Preselected answer on the version screen. */
export function versionDefault(v: string | null): VersionAnswer | undefined {
  const a = isAffected(v);
  if (a === null) return undefined;
  return a ? 'new' : 'old';
}

/** Auto-open rule (PW-D10); `onPairingStage` = StageDeviceNoElgato is showing. */
export function shouldAutoOpen(s: PairingRouteStatus | null, onPairingStage: boolean): boolean {
  return (
    s !== null &&
    s.supported &&
    s.route === 'none' &&
    !s.wizardDismissed &&
    isAffected(s.elgatoVersion) === true &&
    onPairingStage
  );
}
