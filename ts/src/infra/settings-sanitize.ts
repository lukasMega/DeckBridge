// Load/import guards for settings.json sections, split from settings.ts to keep it under the line limit.
import type { Settings } from './settings-store.js';
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

/** Extension folder names: the same shape the extensions controller accepts. */
export const EXTENSION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Saved `enabledExtensions`: well-formed ids only, no duplicates. */
export function sanitizeExtensionIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [
    ...new Set(v.filter((id): id is string => typeof id === 'string' && EXTENSION_ID.test(id))),
  ];
}
