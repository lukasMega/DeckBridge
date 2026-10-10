import type { DialEvent, TouchInputEvent } from '../shared/types.js';
import { renderZone } from './strip.js';
import { DEFAULT_MODEL, findModelById } from '../devices/registry.js';
import type { WsEvents } from '../web/contract.js';
import type { DeckEvents, DemoDeck } from './deck.js';
import { MockDeck } from './mock-deck.js';
import { iconToBase64Jpeg, renderIcon } from './icons.js';
import { FakeSocket } from './socket.js';
import { buildStateResponse, buildStatus } from './state.js';
import type { DemoState } from './state.js';

interface Dependencies {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export class DemoBackend {
  readonly state: DemoState = {
    model: DEFAULT_MODEL,
    plugged: false,
    elgatoConnected: false,
    brightness: 75,
    brightnessOverride: true,
  };
  private currentDeck: DemoDeck = new MockDeck(DEFAULT_MODEL);
  private sockets = new Set<FakeSocket>();
  private listeners = new Set<() => void>();
  private presses: number[] = [];
  private generation = 0;
  private deckGeneration = 0;
  readonly zones = Array.from({ length: 4 }, (_, index) => ({
    value: 50,
    hue: index * 80,
    flash: false,
  }));

  constructor(
    private deps: Dependencies = {
      now: Date.now,
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    },
  ) {}

  get deck(): DemoDeck {
    return this.currentDeck;
  }

  async fetch(input: string, init?: RequestInit): Promise<Response> {
    const path = new URL(input, 'https://demo.invalid').pathname;
    const method = init?.method?.toUpperCase() ?? 'GET';
    const route = `${method} ${path}`;
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    switch (route) {
      case 'GET /api/state':
        return json(buildStateResponse(this.state));
      case 'GET /api/requirements':
        return json([]);
      case 'GET /api/elgato-app/status':
        return json({ running: this.state.elgatoConnected, supported: true });
      case 'POST /api/elgato-app/restart':
        this.restart();
        return json({ ok: true });
      case 'POST /api/brightness':
        this.state.brightness = Number(body.level);
        this.deck.setBrightness(this.state.brightness);
        this.broadcast('brightness', { level: this.state.brightness });
        this.changed();
        return json({});
      case 'POST /api/brightness-override':
        this.state.brightnessOverride = body.enabled === true;
        this.broadcast('brightnessOverride', { enabled: this.state.brightnessOverride });
        return json({});
      case 'POST /api/browser-locale':
        return json({});
    }
    const key = method === 'POST' ? /^\/api\/key\/(\d+)$/.exec(path) : null;
    if (key) {
      const index = Number(key[1]);
      if (index >= buildStatus(this.state).keyCount)
        return json({ error: 'Not available in the demo' }, 404);
      this.keyEvent(index, 'down');
      this.keyEvent(index, 'up');
      return json({});
    }
    return json({ error: 'Not available in the demo' }, 404);
  }

  private restart(): void {
    const generation = this.generation;
    this.deps.setTimeout(() => {
      if (generation !== this.generation || !this.state.plugged) return;
      this.state.elgatoConnected = true;
      this.changed();
      void this.paintAll();
    }, 800);
  }

  openSocket(socket = new FakeSocket()): FakeSocket {
    this.sockets.add(socket);
    return socket;
  }

  broadcast<K extends keyof WsEvents>(event: K, data: WsEvents[K]): void {
    for (const socket of this.sockets) socket.send(event, data);
  }

  keyEvent(index: number, state: 'down' | 'up'): void {
    this.broadcast('keyEvent', { ts: this.deps.now(), mk2Index: index, state });
    if (state === 'down') {
      this.presses[index] = (this.presses[index] ?? 0) + 1;
      void this.paintKey(index);
    }
  }

  async paintKey(index: number): Promise<void> {
    const generation = this.generation;
    const { model } = this.state;
    const canvas = renderIcon(index, this.presses[index] ?? 0, model.keyWidth, model.keyHeight);
    this.deck.paintKey(index, canvas);
    const data = await iconToBase64Jpeg(canvas);
    // Discard an image that finished after disconnect or model change.
    if (data !== null && generation === this.generation)
      this.broadcast('image', { mk2Index: index, format: 'jpeg', data });
  }

  async paintAll(): Promise<void> {
    const generation = this.generation;
    for (
      let index = 0;
      index < buildStatus(this.state).keyCount && generation === this.generation;
      index++
    )
      await this.paintKey(index);
  }

  plugIn(): void {
    this.state.plugged = true;
    this.changed();
  }

  unplug(): void {
    this.generation++;
    this.state.plugged = false;
    this.state.elgatoConnected = false;
    this.presses = [];
    this.broadcast('imagesReset', {});
    this.changed();
  }

  deckEvents(): DeckEvents {
    const generation = ++this.deckGeneration;
    const active = (): boolean =>
      generation === this.deckGeneration && this.state.hardware === true && this.state.plugged;
    return {
      key: (index, state) => {
        if (active()) this.keyEvent(index, state);
      },
      dial: (event) => {
        if (active()) this.dialEvent(event);
      },
      touch: (event) => {
        if (active()) this.touchEvent(event);
      },
      lost: () => {
        if (active()) void this.setModel(DEFAULT_MODEL.id);
      },
    };
  }

  async useDeck(deck: DemoDeck): Promise<void> {
    this.generation++;
    await this.deck.close().catch(() => undefined);
    this.currentDeck = deck;
    this.state.model = deck.model;
    this.state.hardware = deck.kind === 'hw';
    this.state.activity = '';
    this.resetZones();
    this.state.plugged = deck.kind === 'hw';
    this.state.elgatoConnected = deck.kind === 'hw';
    this.presses = [];
    this.broadcast('imagesReset', {});
    this.changed();
    if (deck.kind === 'hw') {
      deck.setBrightness(this.state.brightness);
      void this.paintAll();
      void this.paintStrip();
    }
  }

  async setModel(id: string): Promise<void> {
    const model = findModelById(id);
    if (!model) return;
    this.deckGeneration++;
    this.generation++;
    await this.deck.close().catch(() => undefined);
    this.currentDeck = new MockDeck(model);
    this.state.model = model;
    this.state.hardware = false;
    this.state.activity = '';
    this.resetZones();
    this.reset();
  }

  reset(): void {
    this.state.brightness = 75;
    this.state.brightnessOverride = true;
    this.unplug();
    this.broadcast('brightness', { level: this.state.brightness });
    this.broadcast('brightnessOverride', { enabled: true });
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private resetZones(): void {
    for (const [index, zone] of this.zones.entries()) {
      zone.value = 50;
      zone.hue = index * 80;
      zone.flash = false;
    }
  }

  dialEvent(event: DialEvent): void {
    if (!this.state.hardware || this.state.model.protocol !== 'ajazz-akp05') return;
    const zone = this.zones[event.index];
    if (!zone) return;
    if (event.kind === 'rotate')
      zone.value = Math.max(0, Math.min(100, zone.value + event.delta * 5));
    else if (event.state === 'down') zone.hue = (zone.hue + 70) % 360;
    else return;
    this.state.activity = `Knob ${event.index + 1} → ${zone.value}`;
    this.changed();
    void this.paintStrip();
  }

  touchEvent(event: TouchInputEvent): void {
    if (!this.state.hardware || this.state.model.protocol !== 'ajazz-akp05') return;
    if (event.type === 'swipe') {
      const hues = this.zones.map((zone) => zone.hue);
      const left = (event.endX ?? event.x) < event.x;
      this.zones.forEach((zone, index) => {
        zone.hue = hues[(index + (left ? 1 : 3)) % 4]!;
      });
      this.state.activity = `Swipe ${left ? 'left' : 'right'}`;
    } else if (event.type === 'tap') {
      const index = Math.min(3, Math.max(0, Math.floor(event.x / 200)));
      const zone = this.zones[index]!;
      zone.flash = true;
      this.state.activity = `Strip zone ${index + 1} tapped`;
      const generation = this.generation;
      this.deps.setTimeout(() => {
        if (generation !== this.generation) return;
        zone.flash = false;
        void this.paintStrip();
      }, 200);
    } else return;
    this.changed();
    void this.paintStrip();
  }

  private async paintStrip(): Promise<void> {
    if (
      !this.state.hardware ||
      this.state.model.protocol !== 'ajazz-akp05' ||
      typeof OffscreenCanvas === 'undefined'
    )
      return;
    const generation = this.generation;
    const canvas = new OffscreenCanvas(800, 100);
    const context = canvas.getContext('2d');
    if (!context) return;
    for (const [index, display] of (this.state.model.widgetDisplays ?? []).entries()) {
      const zone = this.zones[index]!;
      const icon = renderZone(
        index,
        zone.value,
        zone.hue,
        zone.flash,
        display.image.width,
        display.image.height,
      );
      if (!icon) continue;
      this.deck.paintStrip?.(index, icon);
      context.drawImage(icon, display.stripX ?? index * 200, 0, display.image.width, 100);
    }
    const data = await iconToBase64Jpeg(canvas);
    if (data !== null && generation === this.generation) this.broadcast('touchImage', { data });
  }

  private changed(): void {
    this.broadcast('status', buildStatus(this.state));
    for (const listener of this.listeners) listener();
  }
}
