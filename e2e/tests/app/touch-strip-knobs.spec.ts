import { selectValue } from '../../helpers/click.js';
import { gotoApp } from '../../helpers/goto.js';
import {
  api,
  connectElgato,
  DEFAULT_DEVICE,
  device,
  deviceEntry,
  dock0,
  expect,
  getSettings,
  getState,
  Marker,
  nextFrame,
  PLUS_PROFILE,
  resetOverride,
  restoreSettings,
  test,
  useDevice,
  waitForState,
  type ElgatoClient,
  type SettingsJson,
} from '../../fixtures/app.js';

const AKP05E = device('ajazz-akp05e');
const KEY = `mock:${AKP05E.id}`;
const NO_REPEAT_MS = 3_600_000;

/** Stream Deck + encoder-rotate report as the child server frames it (cora/plus-reports.ts):
 *  `01 03 <1+count> 00 01 <delta per encoder>` — here knob 0 turned by +1. */
const PLUS_ROTATE_KNOB0 = Buffer.from([0x01, 0x03, 0x05, 0x00, 0x01, 0x01]);

test.describe('touch strip + knobs (AKP05E)', () => {
  let elgato: ElgatoClient | undefined;
  let snapshot: SettingsJson;
  const marker = new Marker();

  test.beforeAll(async ({ app, workerRequest }) => {
    snapshot = await getSettings(workerRequest, app.baseURL);
    elgato = await connectElgato(workerRequest, app.baseURL, app.childPort);
  });

  // Each test starts from the snapshot's per-device settings on an AKP05E (pairs as a Stream Deck + by default).
  test.beforeEach(async ({ request, app }) => {
    await restoreSettings(request, app.baseURL, snapshot);
    await useDevice(request, app.baseURL, AKP05E.id);
  });

  test.afterAll(async ({ app, workerRequest }) => {
    await useDevice(workerRequest, app.baseURL, DEFAULT_DEVICE);
    await resetOverride(workerRequest, app.baseURL, AKP05E.id);
    await restoreSettings(workerRequest, app.baseURL, snapshot);
    await elgato?.close();
    marker.dispose();
  });

  test('strip mode, repaint interval, zones and knobs in the panel', async ({
    page,
    request,
    app,
  }) => {
    const base = app.baseURL;
    await api(request, base, '/api/touch-strip-mode', { mode: 'elgato' });
    await gotoApp(page, `${base}/`);
    const strip = page.getByRole('group', { name: 'Touch strip' });
    const modeSelect = strip.getByLabel('Touch strip mode');
    const repaint = strip.getByText('Repaint after (s)');
    const zoneCount = AKP05E.stripZones!.length;

    // 'elgato': the app owns the strip — plain zone previews, no repaint field, no knob rows.
    await expect(modeSelect).toHaveValue('elgato');
    await expect(
      page.getByRole('list', { name: 'Touch strip zones' }).getByRole('listitem'),
    ).toHaveCount(zoneCount);
    await expect(repaint).toHaveCount(0);
    await expect(strip.getByText('Connect knobs to Elgato app')).toHaveCount(0);

    // The select posts the mode; the server confirms over WS.
    const posted = page.waitForRequest((r) => r.url().endsWith('/api/touch-strip-mode'));
    await selectValue(modeSelect, 'deckbridge-ignore');
    expect((await posted).postDataJSON()).toEqual({ mode: 'deckbridge-ignore' });
    await expect
      .poll(async () => (await getState(request, base)).touchStripMode)
      .toBe('deckbridge-ignore');

    // An override mode turns the zones into tabs, one per widget display.
    const tabs = page.getByRole('tablist', { name: 'Touch strip zones' }).getByRole('tab');
    await expect(tabs).toHaveCount(zoneCount);
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    await expect(repaint).toHaveCount(0);

    // A mode set elsewhere (API) round-trips to the select, and only repaint shows the interval.
    await api(request, base, '/api/touch-strip-mode', { mode: 'deckbridge-repaint' });
    await expect(modeSelect).toHaveValue('deckbridge-repaint');
    await expect(repaint).toHaveCount(1);

    // Knobs: disconnecting them from the app reveals one command row per knob.
    await expect(strip.getByText('Connect knobs to Elgato app')).toHaveCount(1);
    const pressFields = strip.getByLabel(/^Knob \d press command$/);
    await expect(pressFields).toHaveCount(0);
    await api(request, base, '/api/encoders', { connectToApp: false });
    await expect(pressFields).toHaveCount(AKP05E.encoderCount!);
    await api(request, base, '/api/encoders', { commands: { 2: { rotateCw: 'echo cw' } } });
    await expect(strip.getByLabel('Knob 3 turn right command')).toHaveValue('echo cw');

    // Zone assignment shows in its tab and persists per device.
    expect(
      (await api(request, base, '/api/extra-key', { wireId: 2, widget: 'clock' })).status,
    ).toBe(200);
    await expect
      .poll(async () => (await deviceEntry(request, base, KEY))?.extraKeys?.['2'])
      .toEqual({ widget: 'clock' });
  });

  test('strip + knob settings validate and persist', async ({ request, app }) => {
    const base = app.baseURL;
    for (const mode of ['elgato', 'deckbridge-ignore', 'deckbridge-repaint']) {
      const frame = await nextFrame(
        base,
        (f) => f.event === 'touchStripMode',
        () => api(request, base, '/api/touch-strip-mode', { mode }),
      );
      expect(frame.data.mode).toBe(mode);
    }
    expect((await deviceEntry(request, base, KEY))?.touchStripMode).toBe('deckbridge-repaint');
    expect((await api(request, base, '/api/touch-strip-mode', { mode: 'bogus' })).status).toBe(400);

    // Repaint hold-off: 1 s … 1 h, integers only.
    expect((await api(request, base, '/api/touch-strip-repaint', { ms: 1000 })).status).toBe(200);
    expect((await api(request, base, '/api/touch-strip-repaint', { ms: 3_600_000 })).status).toBe(
      200,
    );
    for (const ms of [999, 3_600_001, 1500.5, '2000']) {
      expect(
        (await api(request, base, '/api/touch-strip-repaint', { ms })).status,
        `ms=${ms}`,
      ).toBe(400);
    }
    expect((await getState(request, base)).touchStripRepaintMs).toBe(3_600_000);

    // Knobs: connectToApp + per-knob commands persist (blank fields dropped); index 4 is out.
    expect((await api(request, base, '/api/encoders', { connectToApp: false })).status).toBe(200);
    const cmds = await api(request, base, '/api/encoders', {
      commands: { 0: { press: '  echo press  ', rotateCw: '' } },
    });
    expect(cmds.status).toBe(200);
    expect((await deviceEntry(request, base, KEY))?.encoders).toEqual({
      connectToApp: false,
      commands: { 0: { press: 'echo press' } },
    });
    const knob4 = await api(request, base, '/api/encoders', { commands: { 4: { press: 'x' } } });
    expect(knob4.status).toBe(400);

    // A device without a strip or knobs refuses all three.
    await useDevice(request, base, DEFAULT_DEVICE);
    expect((await api(request, base, '/api/touch-strip-mode', { mode: 'elgato' })).status).toBe(
      409,
    );
    expect((await api(request, base, '/api/touch-strip-repaint', { ms: 5000 })).status).toBe(409);
    expect((await api(request, base, '/api/encoders', { connectToApp: true })).status).toBe(409);
  });

  test('pairs as a Stream Deck + by default: re-laid grid and strip preview', async ({
    page,
    request,
    app,
  }) => {
    const base = app.baseURL;
    const state = await getState(request, base);
    expect([state.keyCount, state.columns, state.rows]).toEqual([
      PLUS_PROFILE.keyCount,
      PLUS_PROFILE.columns,
      PLUS_PROFILE.rows,
    ]);
    expect(dock0(state).coraProfile).toBe(PLUS_PROFILE.advertiseAs);
    expect(dock0(state).touchStripSize).toEqual(PLUS_PROFILE.touchStrip);
    // The physical panel is unchanged; only what the app sees is re-laid.
    expect([dock0(state).keyCount, dock0(state).columns]).toEqual([AKP05E.physicalKeys, 5]);

    await gotoApp(page, `${base}/`);
    const grid = page.locator('#stage .key-grid');
    await expect(grid).toHaveAttribute('data-cora', PLUS_PROFILE.advertiseAs);
    await expect(grid.locator('button[data-key]')).toHaveCount(PLUS_PROFILE.keyCount);
    const canvas = page.locator('.touch-strip-preview');
    await expect(canvas).toHaveAttribute('width', String(PLUS_PROFILE.touchStrip.width));
    await expect(canvas).toHaveAttribute('height', String(PLUS_PROFILE.touchStrip.height));

    // A profile the device does not declare is rejected.
    const bogus = await api(request, base, '/api/device-overrides', {
      modelId: AKP05E.id,
      overrides: { cora: { advertiseAs: 'mini', productId: 0x63 } },
    });
    expect(bogus.status).toBe(400);
  });

  test('knob and strip input: commands, zone refreshes, forwarding to the app', async ({
    request,
    app,
  }) => {
    const base = app.baseURL;
    const count = (tag: string) => (): number => marker.lines().filter((l) => l === tag).length;

    // Widgets on the two left zones, re-run only by a refresh.
    for (const [wireId, tag] of [
      [1, 'zone1'],
      [2, 'zone2'],
    ] as const) {
      const res = await api(request, base, '/api/extra-key', {
        wireId,
        widget: 'command',
        param: marker.command(tag),
        intervalMs: NO_REPEAT_MS,
      });
      expect(res.status).toBe(200);
    }
    await api(request, base, '/api/touch-strip-mode', { mode: 'deckbridge-ignore' });
    await expect.poll(count('zone1')).toBeGreaterThanOrEqual(1);
    await expect.poll(count('zone2')).toBeGreaterThanOrEqual(1);

    // Knobs disconnected: knob 1 has a press command, knob 2 has none.
    await api(request, base, '/api/encoders', {
      connectToApp: false,
      commands: { 0: { press: marker.command('knob1press'), rotateCw: marker.command('knob1cw') } },
    });
    const dial = (body: Record<string, unknown>) => api(request, base, '/api/mock/dial', body);
    expect((await dial({ index: 0, kind: 'press', state: 'down' })).status).toBe(204);
    await dial({ index: 0, kind: 'press', state: 'up' });
    await expect.poll(count('knob1press')).toBe(1);
    await dial({ index: 0, kind: 'rotate', delta: 1 });
    await expect.poll(count('knob1cw')).toBe(1);

    // A press on a knob without a command refreshes the zone above it (knob 2 → zone 2).
    const zone2 = count('zone2')();
    await dial({ index: 1, kind: 'press', state: 'down' });
    await dial({ index: 1, kind: 'press', state: 'up' });
    await expect.poll(count('zone2')).toBe(zone2 + 1);

    // A tap on a widget zone refreshes it (x=100 of the 800-wide strip is zone 1).
    const zone1 = count('zone1')();
    const tap = await nextFrame(
      base,
      (f) => f.event === 'deviceAction' && String(f.data.message).includes('tap'),
      () => api(request, base, '/api/mock/touch', { type: 'tap', x: 100, y: 50 }),
    );
    // The Plus strip is split into knob zones, so the action names the knob above the tap.
    expect(tap.data.message).toBe('Knob 1 touch tap (100, 50)');
    await expect.poll(count('zone1')).toBe(zone1 + 1);
    // Outside the strip is refused.
    expect(
      (await api(request, base, '/api/mock/touch', { type: 'tap', x: 800, y: 0 })).status,
    ).toBe(400);

    // Knobs connected: a turn goes to the Elgato app instead.
    await api(request, base, '/api/encoders', { connectToApp: true });
    await waitForState(request, base, (s) => s.elgatoConnected);
    const cw = count('knob1cw')();
    await dial({ index: 0, kind: 'rotate', delta: 1 });
    await expect.poll(() => elgato!.received().includes(PLUS_ROTATE_KNOB0)).toBe(true);
    expect(count('knob1cw')()).toBe(cw);
  });
});
