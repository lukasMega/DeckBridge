// May this process send the daily ping at all? (telemetry.ts owns the payload.)
// Keeps CI runners and malware-analysis sandboxes from minting installs; pure,
// fails closed. Rationale: docs/privacy.md.

/** Sandbox budgets are short (VirusTotal ~2 min); a real user who keeps the app
 *  open clears this trivially, which is the only population a *daily* ping is
 *  about. Single const so the number can move if vendors extend budgets. */
export const MIN_DWELL_MS = 5 * 60 * 1000;

/** setTimeout jitter can fire a hair under MIN_DWELL_MS and re-trip the dwell
 *  gate. Add this to the schedule delay, not MIN_DWELL_MS alone. */
export const PING_SCHEDULE_SLACK_MS = 2000;

/** Retry cadence once dwell has passed. ping() is idempotent per UTC day
 *  (telemetry.ts), so a suppressed ping gets retried same day, not next. */
export const PING_RETRY_INTERVAL_MS = 60 * 60 * 1000;

export type SuppressReason = 'kill-switch' | 'mock' | 'ci' | 'dwell' | null;

/** Automation markers. Any one present suppresses; the list is deliberately
 *  broader than the CI systems this project uses, since a fork's runner is not
 *  ours to predict. */
const CI_VARS = [
  'CI',
  'CONTINUOUS_INTEGRATION',
  'BUILD_NUMBER',
  'GITHUB_ACTIONS',
  'GITHUB_RUN_ID',
  'RUNNER_OS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'APPVEYOR',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
  'BUILDKITE',
  'TF_BUILD',
  'CODEBUILD_BUILD_ID',
  'DECKBRIDGE_E2E',
  'PLAYWRIGHT_BROWSERS_PATH',
] as const;

export type EnvSnapshot = Readonly<Record<string, string | undefined>>;

/** GitHub sets `CI=true`, but plenty of shells export `CI=false` or an empty
 *  string — neither means "in CI", and treating them as set would silence a
 *  real user's ping forever. */
function isSet(env: EnvSnapshot, name: string): boolean {
  const v = env[name]?.trim().toLowerCase();
  return v !== undefined && v !== '' && v !== '0' && v !== 'false';
}

export interface SuppressInput {
  env: EnvSnapshot;
  /** Milliseconds since process start. */
  uptimeMs: number;
}

/** The reason this process must not ping, or `null` when it may. */
export function suppressReason(input: SuppressInput): SuppressReason {
  const { env } = input;
  // DO_NOT_TRACK is the cross-tool convention; honouring it costs nothing.
  if (isSet(env, 'DECKBRIDGE_NO_TELEMETRY') || isSet(env, 'DO_NOT_TRACK')) return 'kill-switch';
  // No real device, no real user. Looser than driver-manager-discovery.ts's
  // `=== '1'`: a suppressor errs towards silence, a feature switch does not.
  if (isSet(env, 'DECKBRIDGE_MOCK')) return 'mock';
  if (CI_VARS.some((name) => isSet(env, name))) return 'ci';
  // The isFinite half is the fail-closed one: a NaN uptime passes every
  // comparison as false, so a bare `<` would let a broken clock through.
  if (!Number.isFinite(input.uptimeMs) || input.uptimeMs < MIN_DWELL_MS) return 'dwell';
  return null;
}
