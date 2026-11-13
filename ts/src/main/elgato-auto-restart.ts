// Grace-period scheduler that restarts the Elgato Stream Deck desktop app, at
// most once per process, when a dock the app has paired with before connects
// but the app doesn't attach to it on its own before the grace period ends.
// See .claude/plans/2026-09-27_auto-restart-elgato-app.md §4.3 for the design;
// the quit/launch mechanics live in infra/elgato-app.ts. Pure + injected deps
// (no timers/processes touched directly) so this is unit-testable without
// tjs.spawn or real waits — see test/elgato-auto-restart.test.ts.
import { log } from '../shared/logger.js';
import type { ElgatoAppControl } from '../infra/elgato-app.js';
import type { PersistedSettings } from '../infra/settings.js';
import type { WebUIServer } from '../web/server/index.js';
import type { DriverManager } from './driver-manager.js';

const COMPONENT = 'auto-restart';

export interface AutoRestartPending {
  /** Epoch ms of the grace deadline (server clock; never sent to browsers as-is). */
  at: number;
  docks: number[];
}

export interface ElgatoAutoRestartDeps {
  app: Pick<ElgatoAppControl, 'isRunning' | 'restart'>;
  settings: {
    enabled(): boolean;
    delayS(): number;
    wasPaired(deviceKey: string): boolean;
  };
  /** Live: is the Elgato child client attached to this dock right now? */
  isAttached(dockIndex: number): boolean;
  /** webui.snapshot().elgatoAppConflict — the Elgato app already holds the USB
   *  deck, so a restart here could make it grab the hardware back mid-session. */
  conflict(): boolean;
  /** DECKBRIDGE_MOCK / mock driver mode — there is no real app to restart for. */
  mock?(): boolean;
  /** Publish the shared grace deadline + the docks it covers; null releases the
   *  manual pairing controls. Re-called when a further dock joins the set. */
  onPending?: (pending: AutoRestartPending | null) => void;
  /** Defaults to the real setTimeout/clearTimeout; overridden by tests. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
}

/**
 * Restarts the Elgato app at most once per process, after a grace period, for
 * a previously-paired dock the app hasn't reconnected to on its own. One timer
 * is shared across every dock that qualifies while it's pending — a multi-deck
 * restart covers all of them, not one per dock.
 */
export class ElgatoAutoRestart {
  private readonly deps: ElgatoAutoRestartDeps;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (id: ReturnType<typeof setTimeout>) => void;

  private fired = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private restartAt = 0;
  /** Bumped per round so a late `isRunning()` answer can't touch a newer round. */
  private round = 0;
  /** This round's app-running check passed; nothing is published before that. */
  private appConfirmed = false;
  /** Docks that passed every gating rule and are waiting for either the grace
   *  timer to fire or the Elgato app to attach to them on its own. */
  private readonly pendingDocks = new Set<number>();

  constructor(deps: ElgatoAutoRestartDeps) {
    this.deps = deps;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id));
  }

  /** A real USB dock connected. Call once per connect (primary or extra). */
  onDockConnected(dockIndex: number, deviceKey: string): void {
    if (this.fired) {
      log('info', COMPONENT, `dock ${dockIndex}: skip — already restarted once this process`);
      return;
    }
    if (!this.deps.settings.enabled()) {
      log('info', COMPONENT, `dock ${dockIndex}: skip — auto-restart disabled`);
      return;
    }
    if (__MOCK_BUILD__ && this.deps.mock?.()) {
      log('info', COMPONENT, `dock ${dockIndex}: skip — mock mode`);
      return;
    }
    if (!this.deps.settings.wasPaired(deviceKey)) {
      log('info', COMPONENT, `dock ${dockIndex}: skip — not paired before`);
      return;
    }

    // A new round starts clean so docks from an earlier skipped round aren't published.
    if (this.timer === null) this.pendingDocks.clear();
    const joined = !this.pendingDocks.has(dockIndex);
    this.pendingDocks.add(dockIndex);
    if (this.timer !== null) {
      if (joined && this.appConfirmed) this.publishPending();
    } else {
      const delayS = this.deps.settings.delayS();
      log('info', COMPONENT, `dock ${dockIndex}: paired before — grace timer started (${delayS}s)`);
      this.timer = this.setTimer(() => {
        this.timer = null;
        void this.onGraceElapsed().finally(() => {
          if (this.timer === null) this.deps.onPending?.(null);
        });
      }, delayS * 1000);
      this.restartAt = Date.now() + delayS * 1000;
      void this.confirmAppRunning(++this.round);
    }
  }

  /** No countdown for an app that isn't running: it dials docks on its own launch,
   *  so the round is dropped. A failed check keeps the round (grace end re-checks). */
  private async confirmAppRunning(round: number): Promise<void> {
    this.appConfirmed = false;
    const running = await this.deps.app.isRunning().catch(() => true);
    if (round !== this.round || this.timer === null) return;
    if (!running) {
      log(
        'info',
        COMPONENT,
        'skip — Elgato app not running here (it dials docks on its own launch)',
      );
      this.clearTimer(this.timer);
      this.timer = null;
      this.pendingDocks.clear();
      return;
    }
    this.appConfirmed = true;
    this.publishPending();
  }

  private publishPending(): void {
    this.deps.onPending?.({ at: this.restartAt, docks: [...this.pendingDocks] });
  }

  /** The Elgato child client attached to `dockIndex` — on its own, or via a
   *  manual restart elsewhere. Does NOT cancel the timer: an attach can drop
   *  a moment later (seen on hardware: `clientConnected`, then ECONNRESET 1 ms
   *  later), so the decision waits for `onGraceElapsed`, which re-checks the
   *  live `isAttached()` state of every pending dock. */
  onElgatoAttached(dockIndex: number): void {
    if (this.timer !== null && this.pendingDocks.has(dockIndex)) {
      log(
        'info',
        COMPONENT,
        `dock ${dockIndex}: Elgato attached — re-checked when the grace period ends`,
      );
    }
  }

  private async onGraceElapsed(): Promise<void> {
    const stillWaiting = [...this.pendingDocks].some((dock) => !this.deps.isAttached(dock));
    if (!stillWaiting) {
      log('info', COMPONENT, 'skip — every paired dock attached before the grace period ended');
      return;
    }
    if (this.deps.conflict()) {
      log('info', COMPONENT, 'skip — Elgato app conflict (it already holds the USB deck)');
      return;
    }
    if (!(await this.deps.app.isRunning())) {
      log(
        'info',
        COMPONENT,
        'skip — Elgato app not running here (it dials docks on its own launch)',
      );
      return;
    }

    this.fired = true;
    const result = await this.deps.app.restart();
    log('info', COMPONENT, `auto-restart: ${JSON.stringify(result)}`);
  }

  /** Cancel any pending timer (app shutdown). */
  dispose(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.deps.onPending?.(null);
  }
}

/** Builds the real (non-test) deps from app.ts's already-constructed
 *  singletons, so the composition root only has to call `new ElgatoAutoRestart
 *  (createElgatoAutoRestartDeps({ webui, settings, driverManager }))`. */
export function createElgatoAutoRestartDeps(opts: {
  webui: WebUIServer;
  settings: PersistedSettings;
  driverManager: DriverManager;
}): ElgatoAutoRestartDeps {
  const { webui, settings, driverManager } = opts;
  return {
    app: webui.elgatoApp.control,
    settings: {
      enabled: () => settings.elgatoAutoRestartEnabled(),
      delayS: () => settings.elgatoAutoRestartDelaySeconds(),
      wasPaired: (deviceKey) => settings.wasPaired(deviceKey),
    },
    isAttached: (dockIndex) =>
      driverManager.getDockStatuses().find((d) => d.index === dockIndex)?.elgatoConnected ?? false,
    conflict: () => webui.snapshot().elgatoAppConflict,
    onPending: (pending) => webui.notifyElgatoAutoRestart(pending),
    ...(__MOCK_BUILD__ ? { mock: () => driverManager.getDriverMode() === 'mock' } : {}),
  };
}
