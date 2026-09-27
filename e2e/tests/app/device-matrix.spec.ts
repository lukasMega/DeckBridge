import { gotoApp } from '../../helpers/goto.js';
import {
  api,
  DEFAULT_DEVICE,
  DEVICES,
  dock0,
  expect,
  nextFrame,
  test,
  useDevice,
} from '../../fixtures/app.js';

interface TuningView {
  modelId: string;
  modelName: string;
  tunable: { wire: Record<string, unknown> };
  profiles: Array<{ id: string }>;
}

// Every device is switched in place on the one shared instance (the CORA ports are
// fixed, so the suite cannot boot one app per model).
test.describe('device matrix', () => {
  test.afterAll(async ({ app, workerRequest }) => {
    await useDevice(workerRequest, app.baseURL, DEFAULT_DEVICE);
  });

  for (const d of DEVICES) {
    test(`${d.label} (${d.id}) reports its geometry and capabilities`, async ({ request, app }) => {
      const base = app.baseURL;
      const state = await useDevice(request, base, d.id);

      expect(state.modelName).toBe(d.name);
      expect([state.keyCount, state.columns, state.rows]).toEqual([d.keyCount, d.columns, d.rows]);

      // The first WS frame a client gets is the same snapshot.
      const first = await nextFrame(
        base,
        (f) => f.event === 'status',
        async () => {},
      );
      expect(first.data).toMatchObject({
        modelId: d.id,
        modelName: d.name,
        keyCount: d.keyCount,
        columns: d.columns,
        rows: d.rows,
      });

      // Capabilities: presence and absence are both part of the contract.
      const dock = dock0(state);
      expect(dock.modelId).toBe(d.id);
      expect(dock.deviceKey).toBe(`mock:${d.id}`);
      expect(dock.extraKeys).toEqual(d.extraKeys);
      expect(dock.pressableExtraKeys).toBeUndefined();
      expect(dock.encoderCount).toBe(d.encoderCount);
      expect(dock.widgetDisplays?.map((z) => z.wireId)).toEqual(d.stripZones);
      expect(dock.coraProfile).toBe(d.coraProfile);
      expect(dock.touchStripSize).toBeUndefined();

      // Last key of this geometry round-trips HTTP → mock driver → WS (off-by-one guard).
      const last = d.keyCount - 1;
      const press = await nextFrame(
        base,
        (f) => f.event === 'keyEvent',
        () => api(request, base, `/api/key/${last}`, {}),
      );
      expect(press.data.mk2Index).toBe(last);
      expect((await api(request, base, `/api/key/${d.keyCount}`, {})).status).toBe(400);

      // Mock inputs the device cannot produce are refused.
      if (!d.encoderCount) {
        const dial = await api(request, base, '/api/mock/dial', {
          index: 0,
          kind: 'rotate',
          delta: 1,
        });
        expect(dial.status).toBe(400);
        const touch = await api(request, base, '/api/mock/touch', { type: 'tap', x: 1, y: 1 });
        expect(touch.status).toBe(400);
      }
      // Side keys without a switch (293S column) cannot be pressed either.
      const sideKey = d.extraKeys?.[0] ?? 16;
      expect((await api(request, base, `/api/mock/extra-key/${sideKey}`, {})).status).toBe(400);

      // Device tuning lists the model; Elgato HID wire sizes are protocol-fixed.
      const tuning = (await api<TuningView>(request, base, `/api/device-overrides?modelId=${d.id}`))
        .json;
      expect(tuning.modelId).toBe(d.id);
      expect(tuning.modelName).toBe(d.name);
      const wire = Object.keys(tuning.tunable.wire);
      if (d.elgatoHid) {
        expect(wire).not.toContain('packetSize');
        expect(wire).not.toContain('inSize');
      } else {
        expect(wire).toEqual(expect.arrayContaining(['packetSize', 'inSize']));
      }
      expect(tuning.profiles.map((p) => p.id)).toEqual(d.emulations ?? []);
    });
  }

  test('the key grid preview follows every device without a reload', async ({
    page,
    request,
    app,
  }) => {
    await gotoApp(page, `${app.baseURL}/`);
    const grid = page.locator('#stage .key-grid');
    for (const d of DEVICES) {
      await useDevice(request, app.baseURL, d.id);
      // Pushed over the WS status channel: one page load covers all eight devices.
      await expect(grid).toHaveAttribute('data-model', d.id);
      await expect(grid.locator('button[data-key]')).toHaveCount(d.keyCount);
      await expect(grid.locator(`button[data-key="${d.keyCount - 1}"]`)).toHaveCount(1);
      expect(await grid.evaluate((el) => (el as HTMLElement).style.gridTemplateColumns)).toBe(
        `repeat(${d.columns}, 1fr)`,
      );
      // The Mini's 6-key grid gets the compact card.
      await expect(page.locator('#stage .preview')).toHaveClass(
        d.keyCount === 6 ? /\bcompact\b/ : /^(?!.*\bcompact\b)/,
      );
      await expect(page.locator('.step-sub').first()).toHaveText(d.name);
    }
  });
});
