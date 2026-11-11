// `deckbridge relay`: relays an Elgato app on this computer to a DeckBridge on another one.
// Takes no instance lock and writes no log file (stdout only): a bind error already says
// DeckBridge runs here, and a log file would rotate a running DeckBridge's own.
import { isLogLevel, LOG_LEVELS } from '../../shared/cli.js';
import type { CliLogLevel } from '../../shared/cli.js';
import { log, setLogLevel } from '../../shared/logger.js';
import { MdnsAdvertiser } from '../../infra/mdns-advertiser.js';
import { platformName } from '../../infra/os-utils.js';
import { probeIdentity } from './identity.js';
import type { DockIdentity } from './identity.js';
import { CoraRelay } from './relay.js';
import type { RelayPortName, RelaySessionClose } from './relay.js';

export interface RelayArgs {
  target: string;
  targetPort: number;
  listenHost: string;
  name: string;
  advertise: boolean;
  logLevel?: CliLogLevel;
}

// Elgato always dials 5343 on the relay, whatever DECKBRIDGE_CORA_PORT says here.
const RELAY_MAIN_PORT = 5343;
const DEFAULT_TARGET_PORT = 5343;
const DEFAULT_NAME = 'DeckBridge Relay';
const MAX_NAME_LENGTH = 63;
const MAX_TARGET_PORT = 65_534; // the child port is often +1
const PROBE_RETRY_MS = 3000;
const WAIT_WARN_EVERY_MS = 30_000;
const COMPONENT = 'relay';
const MACOS_FIREWALL_HINT =
  'if this repeats and Elgato never pairs, the macOS firewall may block deckbridge: ' +
  'allow incoming connections for it in System Settings > Network > Firewall > Options ' +
  '(again after every binary update)';

const RELAY_USAGE = `Usage: deckbridge relay --target <host> [flags]

  --target <host>           DeckBridge computer to relay to (required)
  --target-port <n>         Its CORA port                      [default ${DEFAULT_TARGET_PORT}]
  --listen-host <host>      Address to listen on               [default 0.0.0.0]
  --name <s>                Name shown in the Elgato app       [default ${DEFAULT_NAME}]
  --no-advertise            Do not advertise via mDNS (add the IP by hand in Elgato)
  --log-level <lvl>         ${LOG_LEVELS.join('|')}
  -h, --help                Show this help`;

type ValueFlag = '--target' | '--target-port' | '--listen-host' | '--name' | '--log-level';
const VALUE_FLAGS: readonly string[] = [
  '--target',
  '--target-port',
  '--listen-host',
  '--name',
  '--log-level',
];

function applyValue(args: Partial<RelayArgs>, flag: ValueFlag, v: string): string | null {
  switch (flag) {
    case '--target':
      args.target = v;
      return null;
    case '--listen-host':
      args.listenHost = v;
      return null;
    case '--target-port': {
      const n = /^\d+$/.test(v) ? Number(v) : 0;
      if (n < 1 || n > MAX_TARGET_PORT) {
        return `--target-port must be an integer from 1 to ${MAX_TARGET_PORT}`;
      }
      args.targetPort = n;
      return null;
    }
    case '--name':
      if (v.length < 1 || v.length > MAX_NAME_LENGTH) {
        return `--name must be 1-${MAX_NAME_LENGTH} characters`;
      }
      args.name = v;
      return null;
    case '--log-level':
      if (!isLogLevel(v)) return `--log-level must be one of ${LOG_LEVELS.join('|')}`;
      args.logLevel = v;
      return null;
  }
}

function collectArgs(rest: string[]): Partial<RelayArgs> | { error: string } {
  const args: Partial<RelayArgs> = {};
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const isValue = VALUE_FLAGS.includes(a);
    if (!isValue && a !== '--no-advertise') return { error: `unknown flag '${a}'` };
    if (seen.has(a)) return { error: `duplicate flag '${a}'` };
    seen.add(a);
    if (!isValue) {
      args.advertise = false;
      continue;
    }
    const v = rest[++i];
    if (v === undefined) return { error: `${a} requires a value` };
    const error = applyValue(args, a as ValueFlag, v);
    if (error !== null) return { error };
  }
  return args;
}

// eslint-disable-next-line sonarjs/function-return-type -- 'help' is part of the spec'd contract
export function parseRelayArgs(rest: string[]): RelayArgs | { error: string } | 'help' {
  if (rest.includes('-h') || rest.includes('--help')) return 'help';
  const args = collectArgs(rest);
  if ('error' in args) return args;
  if (args.target === undefined) return { error: '--target is required' };
  return {
    target: args.target,
    targetPort: args.targetPort ?? DEFAULT_TARGET_PORT,
    listenHost: args.listenHost ?? '0.0.0.0',
    name: args.name ?? DEFAULT_NAME,
    advertise: args.advertise ?? true,
    ...(args.logLevel !== undefined ? { logLevel: args.logLevel } : {}),
  };
}

function rlog(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  log(level, COMPONENT, message);
}

function sleep(ms: number, stop: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    void stop.then(() => {
      clearTimeout(t);
      resolve();
      return undefined;
    });
  });
}

/** Retries until DeckBridge answers; null when a stop signal ended the wait. */
async function waitForDock(
  args: RelayArgs,
  stop: Promise<void>,
  isStopped: () => boolean,
): Promise<DockIdentity | null> {
  let lastWarn = -Infinity;
  while (!isStopped()) {
    try {
      return await probeIdentity(args.target, args.targetPort);
    } catch (e) {
      const now = Date.now();
      if (now - lastWarn >= WAIT_WARN_EVERY_MS) {
        lastWarn = now;
        rlog(
          'warn',
          `waiting for DeckBridge at ${args.target}:${args.targetPort}: ${(e as Error).message}`,
        );
      }
      await sleep(PROBE_RETRY_MS, stop);
    }
  }
  return null;
}

function logOwnAddresses(name: string): void {
  // No `family` at runtime despite tjs.d.ts; an IPv4 address has no ':' (as in app.ts).
  const ips = tjs.system.networkInterfaces
    .filter((n) => !n.internal && !n.address.includes(':'))
    .map((n) => n.address);
  if (ips.length > 0) {
    rlog('info', `if Elgato doesn't list "${name}", add one of these IPs: ${ips.join(', ')}`);
  }
}

function logOpen(id: number, route: RelayPortName, client: string): void {
  rlog('info', `Elgato connected (${route} #${id}) from ${client}`);
}

function logClose(s: RelaySessionClose): void {
  rlog(
    s.closedBy === 'relay' ? 'warn' : 'info',
    `${s.route} #${s.id} closed by ${s.closedBy} (${s.how}) after ` +
      `${(s.durationMs / 1000).toFixed(1)} s, up ${s.bytesUp} B, down ${s.bytesDown} B`,
  );
}

function startAdvertiser(args: RelayArgs, dock: DockIdentity): MdnsAdvertiser | null {
  if (!args.advertise) return null;
  const adv = new MdnsAdvertiser(RELAY_MAIN_PORT, rlog, args.name);
  adv.updateIdentity(dock.productId, dock.serial);
  adv.start().catch((e: unknown) => {
    rlog('warn', `mDNS advertise failed (${(e as Error).message}); relaying without it`);
  });
  return adv;
}

export async function runRelayCommand(rest: string[]): Promise<number> {
  const parsed = parseRelayArgs(rest);
  if (parsed === 'help') {
    console.log(RELAY_USAGE);
    return 0;
  }
  if ('error' in parsed) {
    console.error(`deckbridge relay: ${parsed.error}\n`);
    console.error(RELAY_USAGE);
    return 2;
  }
  const args = parsed;
  if (args.logLevel !== undefined) setLogLevel(args.logLevel);

  let stopped = false;
  const { promise: stop, resolve: signalStop } = Promise.withResolvers<void>();
  const onSignal = (): void => {
    stopped = true;
    signalStop();
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const sig of signals) tjs.addSignalListener(sig, onSignal);

  let relay: CoraRelay | null = null;
  let advertiser: MdnsAdvertiser | null = null;
  try {
    rlog('info', `relay → ${args.target}:${args.targetPort}`);
    const dock = await waitForDock(args, stop, () => stopped);
    if (dock === null) return 0;
    const hex = dock.productId.toString(16).padStart(4, '0');
    rlog('info', `dock: sn=${dock.serial} pid=0x${hex} child port ${dock.childPort}`);

    relay = new CoraRelay({
      listenHost: args.listenHost,
      targetHost: args.target,
      routes: [
        { name: 'main', listenPort: RELAY_MAIN_PORT, targetPort: args.targetPort },
        // Elgato dials the child port from the caps reply on the relay's own IP.
        { name: 'child', listenPort: dock.childPort, targetPort: dock.childPort },
      ],
      onOpen: logOpen,
      onClose: logClose,
      onDroppedAccept: (route, error) => {
        rlog('warn', `a client on ${route} reset before the relay accepted it (${error})`);
        // Seen on macOS only (#257): the firewall drops the socket after the handshake.
        if (platformName() === 'macOS') rlog('warn', MACOS_FIREWALL_HINT);
      },
    });
    try {
      await relay.start();
    } catch (e) {
      rlog(
        'error',
        `can't listen on ${args.listenHost}:${RELAY_MAIN_PORT} or :${dock.childPort} ` +
          `(${(e as Error).message}). Is DeckBridge or another relay running on this computer?`,
      );
      relay = null;
      return 1;
    }
    rlog('info', `listening on ${args.listenHost}:${RELAY_MAIN_PORT} and :${dock.childPort}`);
    advertiser = startAdvertiser(args, dock);
    logOwnAddresses(args.name);
    await stop;
    return 0;
  } finally {
    for (const sig of signals) {
      try {
        tjs.removeSignalListener(sig, onSignal);
      } catch {}
    }
    advertiser?.stop();
    await relay?.stop();
  }
}
