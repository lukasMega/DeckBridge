// Load/import guards for settings.json sections, split from settings.ts to keep it under the line limit.
import type { ExtensionGrant, Settings } from './settings-store.js';
import { isModelOverridesRecord, validateModelOverride } from '../devices/model-overrides.js';
import { findModelById } from '../devices/registry.js';
import type { DeviceModelOverride } from '../devices/driver.js';
import { log } from '../shared/logger.js';
import {
  DEFAULT_BROWSER_DECK_PROFILE,
  isBrowserDeckProfile,
} from '../devices/virtual/browser-deck-profiles.js';

/** Validate a persisted/imported `modelOverrides` map, dropping (with a warn)
 *  every entry that names an unknown model or fails validateModelOverride. Runs
 *  on BOTH disk load and raw-JSON import, same as isDeviceIdentitySettings — an
 *  invalid override must never poison runtime state, and a bad keyMap can make a
 *  device look dead. */
export function sanitizeModelOverrides(raw: unknown): Record<string, DeviceModelOverride> {
  if (raw === undefined) return {};
  if (!isModelOverridesRecord(raw)) {
    log('warn', 'settings', 'modelOverrides: not an object map — ignoring');
    return {};
  }
  const out: Record<string, DeviceModelOverride> = {};
  for (const [modelId, override] of Object.entries(raw)) {
    const model = findModelById(modelId);
    if (!model) {
      log('warn', 'settings', `modelOverrides['${modelId}']: unknown model id — dropped`);
      continue;
    }
    const result = validateModelOverride(override, model);
    if (!result.ok) {
      log(
        'warn',
        'settings',
        `modelOverrides['${modelId}']: dropped — ${result.errors.join('; ')}`,
      );
      continue;
    }
    out[modelId] = result.value;
  }
  return out;
}

/** A saved `virtualDeck` section, or undefined when absent/malformed; an unknown profile falls back. */
export function sanitizeVirtualDeck(
  v: Settings['virtualDeck'],
): { enabled: boolean; profile: string } | undefined {
  if (!v || typeof v.enabled !== 'boolean') return undefined;
  const profile = isBrowserDeckProfile(v.profile) ? v.profile : DEFAULT_BROWSER_DECK_PROFILE;
  return { enabled: v.enabled, profile };
}

/** Grace-period bounds for elgatoAutoRestartDelayS (see
 *  .claude/plans/2026-09-27_auto-restart-elgato-app.md §4.2). */
const ELGATO_AUTO_RESTART_DELAY_S_MIN = 3;
const ELGATO_AUTO_RESTART_DELAY_S_MAX = 120;
export const ELGATO_AUTO_RESTART_DELAY_S_DEFAULT = 10;

/** Clamp a persisted/incoming grace-period value into the accepted range. */
export function clampAutoRestartDelayS(delayS: number): number {
  return Math.min(
    ELGATO_AUTO_RESTART_DELAY_S_MAX,
    Math.max(ELGATO_AUTO_RESTART_DELAY_S_MIN, delayS),
  );
}

/** A saved `verifyDismissed` list: registry model ids only, deduped. */
export function sanitizeVerifyDismissed(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const ids = v.filter((id): id is string => typeof id === 'string' && findModelById(id) !== null);
  return [...new Set(ids)];
}

/** A saved `activeDecks` list: non-empty strings, deduped, at most `max` (the free-tier cap). */
export function sanitizeActiveDecks(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const keys = v.filter((k): k is string => typeof k === 'string' && k !== '' && k.length <= 256);
  return [...new Set(keys)].slice(0, max);
}

/** Extension folder names: the same shape the extensions controller accepts. */
export const EXTENSION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

const EXTENSION_DIGEST = /^[0-9a-f]{64}$/;
// Event names are checked for shape only: the controller knows the real list (infra can't import extension/api).
const EVENT_NAME = /^[a-z]{1,32}$/i;

/** Saved `extensions` grants: well-formed id, digest and events only. Anything else is dropped. */
export function sanitizeExtensionGrants(v: unknown): Record<string, ExtensionGrant> {
  const out: Record<string, ExtensionGrant> = {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out;
  for (const [id, raw] of Object.entries(v)) {
    if (!EXTENSION_ID.test(id) || typeof raw !== 'object' || raw === null) continue;
    const { digest, events } = raw as { digest?: unknown; events?: unknown };
    if (typeof digest !== 'string' || !EXTENSION_DIGEST.test(digest)) continue;
    if (!Array.isArray(events)) continue;
    const names = [
      ...new Set(events.filter((e): e is string => typeof e === 'string' && EVENT_NAME.test(e))),
    ];
    out[id] = { digest, events: names };
  }
  return out;
}
