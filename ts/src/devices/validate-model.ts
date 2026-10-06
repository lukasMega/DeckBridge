// Pure catalog validator: structural invariants every DeviceModel must satisfy. Runs
// from tests and ts/scripts/registry-loader.mjs only — never at production import time.
// Imports stay on pure devices modules (no usb-drivers.ts, which pulls in FFI).
import {
  tunableWireKeys,
  type DeviceImageSpec,
  type DeviceKeyMap,
  type DeviceModel,
  type DeviceProtocol,
} from './driver.js';
import { PROTOCOLS } from './protocol-metadata.js';
import { PROTOCOL_STRATEGY, type ProtocolStrategy } from './protocol/index.js';

type Strategies = Partial<Record<DeviceProtocol, ProtocolStrategy>>;

// Record over keyof: a new ProtocolStrategy member is a compile error until listed here.
const STRATEGY_MEMBERS: Record<keyof ProtocolStrategy, 'function' | 'infoReports'> = {
  writeImage: 'function',
  parseInput: 'function',
  brightnessReport: 'function',
  resetReport: 'function',
  blankImage: 'function',
  infoReports: 'infoReports',
};

const VENDOR_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isU16(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffff;
}

function hex(n: number): string {
  return `0x${n.toString(16).padStart(4, '0')}`;
}

function checkIds(models: readonly DeviceModel[], errors: string[]): void {
  const seen = new Map<string, DeviceModel>();
  for (const m of models) {
    const first = seen.get(m.id);
    if (first) errors.push(`${m.id}: duplicate model id ('${first.name}' and '${m.name}')`);
    else seen.set(m.id, m);
  }
}

function checkUsbIds(m: DeviceModel, errors: string[]): void {
  if (!isU16(m.usbVendorId)) errors.push(`${m.id}: usbVendorId must be an integer in 0..0xffff`);
  for (const pid of m.usbProductIds) {
    if (!isU16(pid)) errors.push(`${m.id}: usbProductIds has ${String(pid)}, need 0..0xffff`);
  }
}

// findModel ignores usage filters, so a shared pair makes the second model unreachable.
function checkOverlap(probed: readonly DeviceModel[], errors: string[]): void {
  const owner = new Map<string, DeviceModel>();
  for (const m of probed) {
    for (const pid of m.usbProductIds) {
      const key = `${hex(m.usbVendorId)}:${hex(pid)}`;
      const first = owner.get(key);
      if (first) errors.push(`${m.id}: USB id ${key} is also claimed by '${first.id}'`);
      else owner.set(key, m);
    }
  }
}

// Per protocol, not per model: a flagged protocol must be backed even when no model uses it yet.
function checkStrategyTable(strategies: Strategies, errors: string[]): void {
  for (const [protocol, meta] of Object.entries(PROTOCOLS)) {
    if (meta.strategy && !strategies[protocol as DeviceProtocol]) {
      errors.push(
        `protocol '${protocol}' is marked strategy: true but has no PROTOCOL_STRATEGY entry`,
      );
    }
  }
}

function checkStrategy(m: DeviceModel, strategies: Strategies, errors: string[]): void {
  if (!PROTOCOLS[m.protocol].strategy) return;
  const strategy = strategies[m.protocol];
  if (!strategy) {
    errors.push(`${m.id}: protocol '${m.protocol}' has no PROTOCOL_STRATEGY entry`);
    return;
  }
  for (const [member, kind] of Object.entries(STRATEGY_MEMBERS)) {
    const value = (strategy as unknown as Record<string, unknown>)[member];
    if (kind === 'function' ? typeof value !== 'function' : !validInfoReports(value)) {
      errors.push(`${m.id}: strategy for '${m.protocol}' is missing a valid '${member}'`);
    }
  }
}

function validInfoReports(v: unknown): boolean {
  const info = v as Record<string, Record<string, unknown> | undefined> | null;
  return ['serial', 'firmware'].every((k) => {
    const r = info?.[k];
    return (
      typeof r?.reportId === 'number' &&
      typeof r.offset === 'number' &&
      typeof r.lengthPrefixed === 'boolean'
    );
  });
}

// Also used for emulation maps, judged against the emulated profile's grid.
function checkKeyMap(
  id: string,
  label: string,
  keyMap: DeviceKeyMap,
  keyCount: number,
  errors: string[],
): void {
  const { coraToWireImage, wireInputToCora } = keyMap;
  if (coraToWireImage && coraToWireImage.length !== keyCount) {
    errors.push(
      `${id}: ${label}.coraToWireImage has ${coraToWireImage.length} entries, advertised grid has ${keyCount} keys`,
    );
  }
  for (const dest of wireInputToCora ?? []) {
    if (dest !== -1 && !(Number.isInteger(dest) && dest >= 0 && dest < keyCount)) {
      errors.push(`${id}: ${label}.wireInputToCora target ${dest} is outside 0..${keyCount - 1}`);
    }
  }
  checkExtraKeys(id, label, keyMap, errors);
}

function checkExtraKeys(id: string, label: string, keyMap: DeviceKeyMap, errors: string[]): void {
  const { wireInputToCora, extraKeys, extraKeyInputs } = keyMap;
  if (extraKeyInputs && extraKeys?.length !== extraKeyInputs.length) {
    errors.push(
      `${id}: ${label}.extraKeyInputs has ${extraKeyInputs.length} entries, extraKeys has ${extraKeys?.length ?? 0}`,
    );
  }
  // An extra key's switch must not also drive a CORA key.
  for (const code of extraKeyInputs ?? []) {
    if (wireInputToCora && (wireInputToCora[code] ?? -1) !== -1) {
      errors.push(`${id}: ${label}.extraKeyInputs code ${code} also maps to a CORA key`);
    }
  }
}

function imageSpecs(m: DeviceModel): Array<[string, DeviceImageSpec]> {
  const specs: Array<[string, DeviceImageSpec]> = [['image', m.image]];
  for (const [key, e] of Object.entries(m.cora.emulations ?? {})) {
    specs.push([`cora.emulations['${key}'].image`, e.image]);
  }
  for (const d of m.widgetDisplays ?? []) {
    specs.push([`widgetDisplays[wireId ${d.wireId}].image`, d.image]);
  }
  if (m.touchStripDisplay) specs.push(['touchStripDisplay.image', m.touchStripDisplay.image]);
  return specs;
}

function checkImages(m: DeviceModel, errors: string[]): void {
  for (const [label, s] of imageSpecs(m)) {
    for (const dim of ['width', 'height'] as const) {
      if (!(Number.isFinite(s[dim]) && s[dim] > 0))
        errors.push(`${m.id}: ${label}.${dim} must be > 0`);
    }
    if (!(Number.isFinite(s.maxBytes) && s.maxBytes >= 0)) {
      errors.push(`${m.id}: ${label}.maxBytes must be >= 0`);
    }
    // BMP models (Mini) carry quality 0 because they never JPEG-encode.
    if (s.format === 'jpeg' && !(s.quality > 0 && s.quality <= 1)) {
      errors.push(`${m.id}: ${label}.quality must be in (0, 1] for JPEG`);
    }
  }
}

/** Why a cycle matters: advertisedModel() resolves one hop, so a loop would make two
 *  models each claim the other's geometry. */
function hasAdvertiseCycle(m: DeviceModel, byId: Map<string, DeviceModel>): boolean {
  const visited = new Set<string>();
  for (let cur: DeviceModel | undefined = m; cur; cur = byId.get(cur.cora.advertiseAs ?? '')) {
    if (visited.has(cur.id)) return true;
    visited.add(cur.id);
  }
  return false;
}

function checkCora(
  m: DeviceModel,
  byId: Map<string, DeviceModel>,
  profileIds: Set<string>,
  errors: string[],
): void {
  const { advertiseAs, productId, emulations } = m.cora;
  if (!isU16(productId)) errors.push(`${m.id}: cora.productId must be an integer in 0..0xffff`);
  for (const key of Object.keys(emulations ?? {})) {
    if (!profileIds.has(key))
      errors.push(`${m.id}: cora.emulations key '${key}' is not a CORA profile`);
  }
  const advertised = advertiseAs ? byId.get(advertiseAs) : m;
  if (!advertised) {
    errors.push(`${m.id}: cora.advertiseAs '${advertiseAs}' does not resolve to a model`);
    return;
  }
  if (hasAdvertiseCycle(m, byId)) errors.push(`${m.id}: cora.advertiseAs forms a cycle`);
  // Mirabox boards advertise a PID of the emulated family (0xa5 is an MK.2 PID, not
  // mk2's own cora.productId), so "one of its PIDs" is the strictest rule that fits.
  const pids =
    advertised === m ? m.usbProductIds : [advertised.cora.productId, ...advertised.usbProductIds];
  if (isU16(productId) && !pids.includes(productId)) {
    errors.push(
      `${m.id}: cora.productId ${hex(productId)} is not a PID of advertised model '${advertised.id}'`,
    );
  }
  checkKeyMap(m.id, 'keyMap', m.keyMap, advertised.keyCount, errors);
  for (const [key, e] of Object.entries(emulations ?? {})) {
    const profile = byId.get(key);
    if (profile) {
      checkKeyMap(m.id, `cora.emulations['${key}'].keyMap`, e.keyMap, profile.keyCount, errors);
    }
  }
}

function checkWireAndProtocol(m: DeviceModel, strategies: Strategies, errors: string[]): void {
  if (!Object.hasOwn(PROTOCOLS, m.protocol)) {
    errors.push(`${m.id}: unknown protocol '${m.protocol}'`);
    return;
  }
  checkStrategy(m, strategies, errors);
  // MiraboxDriver reads heartbeatMs with `!`; unset would spin setInterval at ~0 ms.
  if (PROTOCOLS[m.protocol].family.startsWith('mirabox') && (m.wire.heartbeatMs ?? 0) <= 0) {
    errors.push(`${m.id}: wire.heartbeatMs must be > 0 for '${m.protocol}'`);
  }
  if (
    m.wire.batchImageTransfers === true &&
    !tunableWireKeys(m.protocol).includes('batchImageTransfers')
  ) {
    errors.push(`${m.id}: wire.batchImageTransfers is not supported by '${m.protocol}'`);
  }
}

function checkModel(
  m: DeviceModel,
  byId: Map<string, DeviceModel>,
  profileIds: Set<string>,
  strategies: Strategies,
  errors: string[],
): void {
  checkUsbIds(m, errors);
  checkWireAndProtocol(m, strategies, errors);
  if (m.keyCount !== m.rows * m.columns) {
    errors.push(`${m.id}: keyCount ${m.keyCount} != rows ${m.rows} * columns ${m.columns}`);
  }
  checkCora(m, byId, profileIds, errors);
  checkImages(m, errors);
  const candidates = m.wire.packetSizeCandidates;
  if (candidates && !candidates.includes(m.wire.packetSize)) {
    errors.push(
      `${m.id}: wire.packetSizeCandidates does not include packetSize ${m.wire.packetSize}`,
    );
  }
  if (!VENDOR_SLUG.test(m.vendor))
    errors.push(`${m.id}: vendor '${m.vendor}' is not a kebab-case slug`);
}

/** Every structural problem in the catalog, each naming the model id(s) involved.
 *  `strategies` is injectable only so tests can feed a broken table. */
export function validateCatalog(
  models: readonly DeviceModel[],
  profiles: readonly DeviceModel[],
  strategies: Strategies = PROTOCOL_STRATEGY,
): string[] {
  const errors: string[] = [];
  checkStrategyTable(strategies, errors);
  const all = [...models, ...profiles];
  checkIds(all, errors);
  checkOverlap(models, errors);
  const byId = new Map(all.map((m) => [m.id, m]));
  const profileIds = new Set(profiles.map((p) => p.id));
  for (const m of all) checkModel(m, byId, profileIds, strategies, errors);
  return errors;
}
