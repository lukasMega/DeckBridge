import assert from 'tjs:assert';
import { MockDriver } from '../src/devices/mock.js';
import { AJAZZ_AKP05E_MODEL } from '../src/devices/ajazz/akp05e.js';
import { wireMockDriverEvents } from '../src/main/dock-status.js';
import { composeWidgetBmp } from '../src/shared/widget-raster.js';
import { jpegSize } from '../src/devices/jpeg-size.js';
import { test, summaryExit } from './helpers/harness.js';

test('mock widget uploads reach strip preview and clear it', () => {
  const driver = new MockDriver(AJAZZ_AKP05E_MODEL);
  const writes: Array<[number, Uint8Array, boolean]> = [];
  wireMockDriverEvents(driver, {
    onKey: () => undefined,
    onReinit: () => undefined,
    onStripWrite: (wireId, jpeg, full) => writes.push([wireId, jpeg, full]),
  });
  const display = AJAZZ_AKP05E_MODEL.widgetDisplays![0]!;
  driver.sendSplashImage(
    display.wireId,
    composeWidgetBmp([{ text: 'uptime', big: false }], display.image.width, display.image.height),
    display.image,
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0]![0], display.wireId);
  assert.deepEqual(jpegSize(writes[0]![1]), {
    width: display.image.width,
    height: display.image.height,
  });
  assert.equal(writes[0]![2], false);

  driver.clearKey(display.wireId);
  assert.equal(writes.length, 2);
  assert.deepEqual(jpegSize(writes[1]![1]), {
    width: display.image.width,
    height: display.image.height,
  });
});

summaryExit();
