// temp analysis: measure k1pro splash encode sizes (old vs new spec)
import { transformImageForDevice, closeSidecar } from '../src/translator.js';
import { MIRABOX_K1PRO_MODEL } from '../src/devices/mirabox/mirabox-k1pro.js';
import { SPLASH_STATES } from '../src/assets/splash-states.js';

const model = MIRABOX_K1PRO_MODEL;
const t = model.splash!.transformOverride!;
const spec = { ...model.image, rotate: t.rotate!, flipH: t.flipH! };

for (const name of ['connecting', 'connected', 'error'] as const) {
  const src = Buffer.from(SPLASH_STATES[name], 'base64');
  for (const mb of [0, 1600]) {
    const out = transformImageForDevice(src, { ...spec, maxBytes: mb });
    console.log(`${name} maxBytes=${mb}: ${out.length}B`);
    // eslint-disable-next-line sonarjs/publicly-writable-directories
    await tjs.makeDir('/tmp/k1pro-splash', { recursive: true });
    await tjs.writeFile(`/tmp/k1pro-splash/${name}-mb${mb}.jpg`, out);
  }
}
closeSidecar();
