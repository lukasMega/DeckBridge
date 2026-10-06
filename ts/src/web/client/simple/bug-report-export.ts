// "Copy for bug report": what a maintainer needs to reproduce a device report, and nothing
// else. Built only from the tuning view and key events the panel already holds, so settings
// commands and unrelated settings can never leak into it.
import type { DeviceOverridesView, KeyEvent } from '../ui-types.js';

type DeviceOverrides = DeviceOverridesView['overrides'];

export interface RawInputSample {
  state: KeyEvent['state'];
  wireId: number;
  mk2Index: number;
}

export interface BugReportExport {
  modelId: string;
  appVersion: string;
  /** Exactly what POST /api/device-overrides accepts (validateModelOverride round-trips it). */
  overrides: DeviceOverrides;
  advertiseAs?: string;
  rawInputSamples?: RawInputSample[];
}

/** Newest first in the store; a handful is enough to show the wire-id pattern. */
const MAX_SAMPLES = 20;

/** Only events carrying a raw wire id say anything about the wire; mapped ones are noise. */
function inputSamples(events: readonly KeyEvent[]): RawInputSample[] {
  const samples: RawInputSample[] = [];
  for (const e of events) {
    if (e.wireId === undefined) continue;
    samples.push({ state: e.state, wireId: e.wireId, mk2Index: e.mk2Index });
    if (samples.length === MAX_SAMPLES) break;
  }
  return samples;
}

/** `inputModelId` is the model that produced `keyEvents`: only the primary dock feeds
 *  them, so another dock's report must not carry its wire ids. */
export function buildBugReport(
  view: DeviceOverridesView,
  appVersion: string,
  keyEvents: readonly KeyEvent[],
  inputModelId: string,
): BugReportExport {
  const advertiseAs = view.effective.cora?.advertiseAs;
  const samples = inputModelId === view.modelId ? inputSamples(keyEvents) : [];
  return {
    modelId: view.modelId,
    appVersion,
    overrides: view.overrides,
    ...(advertiseAs ? { advertiseAs } : {}),
    ...(samples.length > 0 ? { rawInputSamples: samples } : {}),
  };
}
