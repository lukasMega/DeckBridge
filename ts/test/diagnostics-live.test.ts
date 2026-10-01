import assert from 'tjs:assert';
import { buildLiveDiagnostics } from '../src/web/server/diagnostics-sources.js';
import type { LiveDiagnosticsInputs } from '../src/web/server/diagnostics-sources.js';
import { deviceRowsFromInventory } from '../src/cli/devices.js';
import { DEVICE_MODELS } from '../src/devices/registry.js';
import type { HidDeviceInfo } from '../src/ffi/hidapi.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';

const elgato = DEVICE_MODELS.find((m) => m.usagePage === undefined)!;

function hid(over: Partial<HidDeviceInfo>): HidDeviceInfo {
  return {
    vendorId: elgato.usbVendorId,
    productId: elgato.usbProductIds[0]!,
    usagePage: 1,
    usage: 1,
    interfaceNumber: 0,
    manufacturer: 'm',
    product: 'p',
    serial: 'S1',
    path: 'inv-path',
    ...over,
  };
}

function inputs(inventory: LiveDiagnosticsInputs['inventory']): LiveDiagnosticsInputs {
  return {
    cacheRoot: '/nonexistent-deckbridge-diag',
    logPath: '/x/log',
    logLevel: 'info',
    uptimeMs: 1,
    state: { updateInfo: { enabled: false } } as unknown as LiveDiagnosticsInputs['state'],
    settingsJson: '{}',
    modelOverrides: {},
    effectiveModels: {},
    comms: [],
    keyEvents: [],
    ringLogs: [],
    inventory,
  };
}

console.log('\nlive diagnostics inventory');

await test('rows and table come from the injected inventory (no sync FFI)', async () => {
  // Sync enumerators have no native lib here and would see nothing; the unknown
  // device and the Elgato row can only come from the injected inventory.
  const report = await buildLiveDiagnostics(
    inputs(() =>
      Promise.resolve({
        devices: [hid({}), hid({ vendorId: 0xdead, productId: 0xbeef, path: 'odd-path' })],
        tookMs: 4321,
      }),
    ),
  );
  assert.ok(report.includes('took 4321ms'));
  assert.ok(report.includes('odd-path'));
  assert.ok(report.includes(elgato.name));
});

await test('inventory failure is reported, not thrown', async () => {
  const report = await buildLiveDiagnostics(
    inputs(() => Promise.reject(new Error('HID discovery disposed'))),
  );
  assert.ok(report.includes('unavailable: HID discovery disposed'));
});

await test('deviceRowsFromInventory is pure and matches by registry', () => {
  const rows = deviceRowsFromInventory([hid({}), hid({ vendorId: 1, productId: 2 })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.supported, 'yes');
});

summaryExit();
