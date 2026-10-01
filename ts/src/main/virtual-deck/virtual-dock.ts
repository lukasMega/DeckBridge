// Lifecycle of the browser deck: the dock at VIRTUAL_DOCK_INDEX, its driver, the hub and the
// deck-only listener. Everything starts together and unwinds together.
import { log } from '../../shared/logger.js';
import {
  CORA_PORT_STRIDE,
  ELGATO_CHILD_PORT,
  ELGATO_TCP_PORT,
  MDNS_SERVICE_NAME,
  VIRTUAL_DOCK_INDEX,
  bindAddr,
  deckPort,
} from '../../shared/types.js';
import { BROWSER_DECK_PROFILES } from '../../devices/virtual/browser-deck-profiles.js';
import { SERIAL_KEY_PREFIX } from '../../infra/device-identity.js';
import type { PersistedSettings } from '../../infra/settings.js';
import {
  DeckHub,
  type DeckByeReason,
  type DeckSource,
} from '../../web/server/virtual-deck/deck-hub.js';
import { DeckServer } from '../../web/server/virtual-deck/deck-server.js';
import type { VirtualDeckController } from '../../web/server/virtual-deck/virtual-deck-controller.js';
import type { CoraDockFactory } from '../dock-scanner-deps.js';
import { dockSlot } from '../dock-status.js';
import { Dock, type DockHooks } from '../dock.js';
import { VirtualDeckDriver } from './virtual-deck-driver.js';

/** `usb:` so settings.json keeps the identity across restarts (see isStableDeviceKey): the
 *  Elgato app keys a device by its serial, so a stable one keeps the profile. */
export const VIRTUAL_DECK_DEVICE_KEY = `${SERIAL_KEY_PREFIX}virtual-deck-1`;

/** The slice of DriverManager the browser deck needs. */
export interface VirtualDockHost {
  hooksForDock(index: number): DockHooks;
  addExternalDock(dock: Dock): void;
  removeExternalDock(index: number): void;
}

export interface VirtualDockDeps {
  controller: VirtualDeckController;
  settings: PersistedSettings;
  host: VirtualDockHost;
  coraDockFactory: CoraDockFactory;
  getShuttingDown: () => boolean;
  onDockConnected?: (dockIndex: number, deviceKey: string) => void;
  /** Test seams. */
  port?: () => number;
  listenIp?: () => string;
}

const BYE_FLUSH_MS = 150;

interface Running {
  profile: string;
  dock: Dock;
  driver: VirtualDeckDriver;
  hub: DeckHub;
  server: DeckServer;
}

export class VirtualDock {
  private running: Running | null = null;
  /** start/stop never overlap: a toggle during a bind must not interleave. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: VirtualDockDeps) {}

  get isRunning(): boolean {
    return this.running !== null;
  }

  /** Reconcile what runs with settings.virtualDeck (enabled + profile). */
  sync(): Promise<void> {
    this.chain = this.chain.then(() => this.reconcile()).catch(() => undefined);
    return this.chain;
  }

  /** Close every page using this token (revoke); a no-op while stopped. */
  kick(tokenId: string, reason: DeckByeReason = 'revoked'): void {
    this.running?.hub.kick(tokenId, reason);
  }

  async shutdown(): Promise<void> {
    this.chain = this.chain.then(() => this.stop('disabled')).catch(() => undefined);
    await this.chain;
  }

  private async reconcile(): Promise<void> {
    const want = this.deps.settings.virtualDeck;
    const wanted = want.enabled && !this.deps.getShuttingDown();
    if (this.running && (!wanted || this.running.profile !== want.profile)) {
      await this.stop(wanted ? 'upgrade' : 'disabled');
    }
    if (wanted && !this.running) await this.start(want.profile);
  }

  private async start(profileId: string): Promise<void> {
    const { controller, settings, host } = this.deps;
    const profile = BROWSER_DECK_PROFILES[profileId as keyof typeof BROWSER_DECK_PROFILES];
    const driver = new VirtualDeckDriver(profileId as keyof typeof BROWSER_DECK_PROFILES);
    const identity = settings.getOrCreateIdentity(
      VIRTUAL_DECK_DEVICE_KEY,
      `${MDNS_SERVICE_NAME} (Browser)`,
    );
    const slot = dockSlot(VIRTUAL_DOCK_INDEX, identity);
    let dock: Dock | null = null;
    const source: DeckSource = {
      layout: () => driver.layout(),
      snapshot: () => driver.snapshot(),
      brightness: () => driver.brightnessLevel(),
      elgatoPaired: () => dock?.cora.childHasClient ?? false,
      input: (key, state) => driver.input(key, state),
    };
    const hub = new DeckHub({
      source,
      auth: controller.auth,
      limits: controller.limits,
      log: (level, message) => log(level, 'deck', message),
    });
    const server = new DeckServer({
      port: (this.deps.port ?? deckPort)(),
      listenIp: (this.deps.listenIp ?? bindAddr)(),
      hub,
      auth: controller.auth,
      log: (level, message) => log(level, 'deck', message),
    });
    driver.setSink(hub);
    const hooks = host.hooksForDock(VIRTUAL_DOCK_INDEX);
    dock = new Dock({
      index: VIRTUAL_DOCK_INDEX,
      cora: this.deps.coraDockFactory(slot),
      ports: { primary: slot.primaryPort, child: slot.childPort },
      settings,
      identity: slot,
      model: profile.model,
      getShuttingDown: this.deps.getShuttingDown,
      hooks,
      statusExtra: () => ({ virtualClients: hub.clients().length }),
    });
    hub.onClientsChanged = () => hooks.changed?.();
    let registered = false;
    try {
      host.addExternalDock(dock);
      registered = true;
      await dock.start(driver);
      const child = dock.cora.childServer;
      child.on('clientConnected', () => hub.paired(true));
      child.on('clientDisconnected', () => hub.paired(false));
      await server.start();
    } catch (e) {
      const message = (e as Error).message;
      log('warn', 'deck', `browser deck failed to start: ${message}`);
      controller.lastError = message;
      await dock.stop().catch(() => undefined);
      if (registered) host.removeExternalDock(VIRTUAL_DOCK_INDEX);
      await server.stop().catch(() => undefined);
      return;
    }
    controller.lastError = undefined;
    controller.runtime = { server, hub };
    this.running = { profile: profileId, dock, driver, hub, server };
    log(
      'info',
      'deck',
      `browser deck up: page :${server.port}, dock ${VIRTUAL_DOCK_INDEX} ports ${slot.primaryPort}/${slot.childPort}`,
    );
    this.deps.onDockConnected?.(VIRTUAL_DOCK_INDEX, VIRTUAL_DECK_DEVICE_KEY);
  }

  private async stop(reason: DeckByeReason): Promise<void> {
    const r = this.running;
    if (!r) return;
    this.running = null;
    this.deps.controller.runtime = null;
    const hadPages = r.hub.clients().length > 0;
    r.hub.closeAll(reason);
    // Closing the listener right away can drop the `bye` still in the socket buffer.
    if (hadPages) await new Promise<void>((done) => setTimeout(done, BYE_FLUSH_MS));
    await r.server.stop().catch(() => undefined);
    r.driver.setSink(null);
    await r.dock
      .stop()
      .catch((e: unknown) =>
        log('warn', 'deck', `browser deck dock stop failed: ${(e as Error).message}`),
      );
    this.deps.host.removeExternalDock(VIRTUAL_DOCK_INDEX);
    log('info', 'deck', 'browser deck stopped');
  }
}

/** The CORA ports dock `VIRTUAL_DOCK_INDEX` listens on (for docs/tests). */
export const VIRTUAL_DOCK_PORTS = {
  primary: ELGATO_TCP_PORT + CORA_PORT_STRIDE * VIRTUAL_DOCK_INDEX,
  child: ELGATO_CHILD_PORT + CORA_PORT_STRIDE * VIRTUAL_DOCK_INDEX,
};
