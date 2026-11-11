import net, { type Server, type Socket } from 'node:net';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';

type FramesMode = 'main' | 'all' | 'off';

interface Options {
  listenHost: string;
  targetHost: string;
  mainPort: number;
  childPort: number;
  targetMainPort: number;
  targetChildPort: number;
  frames: FramesMode;
  hex: boolean;
  advertise: boolean;
  advertiseName: string;
  sn: string | undefined;
  pid: string | undefined;
}

interface Session {
  closeLocal: () => void;
}

const CONNECT_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 2_000;
const MAX_TAP_BYTES = 1024 * 1024;
const HEADER_LEN = 16;
const CHILD_HEX_PAYLOAD = 64;
const MAGIC = Buffer.from([0x43, 0x93, 0x8a, 0x41]);
// Same values as MDNS_TXT_DEVICE_TYPE / MDNS_TXT_VID in ts/src/shared/types.ts.
const MDNS_DT = '215';
const MDNS_VID = '4057';

const BOOLEAN_FLAGS = new Set(['--help', '--hex', '--advertise']);
const VALUE_OPTIONS = new Set(
  (
    '--target-host --listen-host --main-port --child-port --target-main-port ' +
    '--target-child-port --frames --advertise-name --sn --pid'
  ).split(' '),
);

const sessions = new Set<Session>();
const servers: Server[] = [];
let mdnsProc: ChildProcess | null = null;
let connCounter = 0;
let shuttingDown = false;

function usage(): string {
  return [
    'Usage: node src/index.ts --target-host <ip> [options]',
    '',
    'Options:',
    '  --target-host <ip>            Machine running DeckBridge (required)',
    '  --listen-host <host>          Address to listen on (default: 0.0.0.0)',
    '  --main-port <port>            Proxy listen port (default: 5343)',
    '  --child-port <port>           Child proxy listen port (default: 5344)',
    '  --target-main-port <port>     DeckBridge main TCP port (default: 5343)',
    '  --target-child-port <port>    DeckBridge child TCP port (default: 5344)',
    '  --frames <main|all|off>       Which relay logs CORA frame lines (default: main)',
    '  --hex                         Append frame bytes to frame lines',
    '  --advertise                   Advertise _elg._tcp with dns-sd (macOS only)',
    '  --advertise-name <name>       mDNS instance name (default: DeckBridge Proxy)',
    '  --sn <serial>                 TXT sn, required with --advertise',
    '  --pid <n>                     TXT pid (decimal), required with --advertise',
    '  --help                        Show this help',
  ].join('\n');
}

function parsePort(value: string | undefined, option: string, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (!/^\d+$/.test(value)) throw new Error(`${option} must be an integer from 1 to 65535`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${option} must be an integer from 1 to 65535`);
  }
  return port;
}

function parseArgs(args: string[]): Options | null {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help') {
      console.log(usage());
      return null;
    }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    if (BOOLEAN_FLAGS.has(arg)) {
      if (flags.has(arg)) throw new Error(`Option specified more than once: ${arg}`);
      flags.add(arg);
      continue;
    }
    if (!VALUE_OPTIONS.has(arg)) throw new Error(`Unknown option: ${arg}`);
    if (values.has(arg)) throw new Error(`Option specified more than once: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    values.set(arg, value);
  }

  const targetHost = values.get('--target-host');
  if (!targetHost) throw new Error('--target-host is required (the machine running DeckBridge)');

  const frames = values.get('--frames') ?? 'main';
  if (frames !== 'main' && frames !== 'all' && frames !== 'off') {
    throw new Error('--frames must be one of: main, all, off');
  }
  const pid = values.get('--pid');
  if (pid !== undefined && !/^\d+$/.test(pid)) throw new Error('--pid must be a decimal integer');

  const options: Options = {
    listenHost: values.get('--listen-host') ?? '0.0.0.0',
    targetHost,
    mainPort: parsePort(values.get('--main-port'), '--main-port', 5343),
    childPort: parsePort(values.get('--child-port'), '--child-port', 5344),
    targetMainPort: parsePort(values.get('--target-main-port'), '--target-main-port', 5343),
    targetChildPort: parsePort(values.get('--target-child-port'), '--target-child-port', 5344),
    frames,
    hex: flags.has('--hex'),
    advertise: flags.has('--advertise'),
    advertiseName: values.get('--advertise-name') ?? 'DeckBridge Proxy',
    sn: values.get('--sn'),
    pid,
  };

  if (options.mainPort === options.childPort) {
    throw new Error('--main-port and --child-port must be different');
  }
  if (options.advertise && (!options.sn || !options.pid)) {
    throw new Error("--advertise requires --sn and --pid (copy them from DeckBridge's advert)");
  }
  return options;
}

function ts(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function log(tag: string, message: string): void {
  console.log(`${ts()} [${tag}] ${message}`);
}

function warn(tag: string, message: string): void {
  console.error(`${ts()} [${tag}] ${message}`);
}

function flagString(flags: number): string {
  const parts: string[] = [];
  if (flags & 0x8000) parts.push('VERB');
  if (flags & 0x4000) parts.push('REQACK');
  if (flags & 0x0200) parts.push('ACKNAK');
  if (flags & 0x0100) parts.push('RESULT');
  return parts.length ? parts.join('|') : '0';
}

interface Tap {
  feed: (chunk: Buffer) => void;
  frames: () => number;
}

// Passive: reads copies of relayed chunks, never touches the relayed bytes.
function createTap(
  tag: string,
  dir: string,
  logFrames: boolean,
  hex: boolean,
  child: boolean,
): Tap {
  let buf: Buffer = Buffer.alloc(0);
  let disabled = false;
  let count = 0;
  let skipped = 0;

  function disable(reason: string): void {
    disabled = true;
    buf = Buffer.alloc(0);
    warn(tag, `${dir} frame tap disabled: ${reason}`);
  }

  function drain(): void {
    for (;;) {
      if (buf.length >= MAGIC.length && !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
        const idx = buf.indexOf(MAGIC);
        if (idx === -1) {
          // Keep a possible partial magic at the tail.
          const drop = buf.length - (MAGIC.length - 1);
          skipped += drop;
          buf = buf.subarray(drop);
          return;
        }
        skipped += idx;
        buf = buf.subarray(idx);
      }
      if (buf.length < HEADER_LEN) return;
      if (skipped > 0) {
        log(tag, `${dir} skipped ${skipped} non-CORA bytes`);
        skipped = 0;
      }
      const flags = buf.readUInt16LE(4);
      const hidOp = buf[6]!;
      const msgId = buf.readUInt32LE(8);
      const len = buf.readUInt32LE(12);
      if (len > MAX_TAP_BYTES) {
        disable(`frame declares ${len} payload bytes (cap ${MAX_TAP_BYTES})`);
        return;
      }
      const total = HEADER_LEN + len;
      if (buf.length < total) return;
      count++;
      if (logFrames) {
        let line =
          `${dir} flags=${flagString(flags)} hidOp=0x${hidOp.toString(16).padStart(2, '0')} ` +
          `msgId=${msgId} len=${len}`;
        if (hex) {
          const end = child ? Math.min(total, HEADER_LEN + CHILD_HEX_PAYLOAD) : total;
          line += ` raw=${buf.subarray(0, end).toString('hex')}`;
        }
        log(tag, line);
      }
      buf = buf.subarray(total);
    }
  }

  return {
    feed(chunk) {
      if (disabled) return;
      try {
        buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
        if (buf.length > MAX_TAP_BYTES + HEADER_LEN) {
          disable('buffer cap exceeded');
          return;
        }
        drain();
      } catch (error) {
        disable(error instanceof Error ? error.message : String(error));
      }
    },
    frames: () => count,
  };
}

function reset(socket: Socket): void {
  if (socket.destroyed) return;
  if (socket.connecting) socket.destroy();
  else socket.resetAndDestroy();
}

function handleConnection(name: string, client: Socket, options: Options, port: number): void {
  const id = ++connCounter;
  const tag = `${name} #${id}`;
  const isChild = name === 'child';
  const logFrames = options.frames === 'all' || (options.frames === 'main' && !isChild);
  const startedAt = Date.now();
  const clientAddr = `${client.remoteAddress}:${client.remotePort}`;
  let first: { side: string; how: string } | null = null;
  let closed = 0;
  let toD = 0;
  let toE = 0;

  log(tag, `accept from ${clientAddr}`);
  client.setNoDelay(true);

  const upstream = net.createConnection({
    host: options.targetHost,
    port,
    allowHalfOpen: true,
    noDelay: true,
  });
  upstream.setNoDelay(true);

  const tapEtoD = createTap(tag, 'E->D', logFrames, options.hex, isChild);
  const tapDtoE = createTap(tag, 'D->E', logFrames, options.hex, isChild);

  function markClose(side: string, how: string): void {
    if (first) return;
    first = { side, how };
    log(tag, `${side} closed first: ${how}`);
  }

  function onClose(): void {
    if (++closed < 2) return;
    sessions.delete(session);
    const f = first ?? { side: '?', how: 'unknown' };
    log(
      tag,
      `closed: first=${f.side} how=${f.how} duration=${Date.now() - startedAt}ms ` +
        `bytes E->D=${toD} D->E=${toE} frames E->D=${tapEtoD.frames()} D->E=${tapDtoE.frames()}`,
    );
  }

  const session: Session = {
    closeLocal() {
      markClose('local', 'local shutdown');
      client.destroy();
      upstream.destroy();
    },
  };
  sessions.add(session);

  const connectStart = Date.now();
  const connectTimer = setTimeout(function onConnectTimeout() {
    markClose('D', 'timeout');
    reset(client);
    upstream.destroy();
  }, CONNECT_TIMEOUT_MS);
  connectTimer.unref();

  function wireSide(side: 'E' | 'D', sock: Socket, other: Socket): void {
    sock.on('end', function onEnd() {
      markClose(side, 'FIN');
    });
    sock.on('error', function onError(error: NodeJS.ErrnoException) {
      clearTimeout(connectTimer);
      if (error.code === 'ECONNRESET') {
        markClose(side, 'RST');
        reset(other);
      } else {
        markClose(side, `error ${error.code ?? error.message}`);
        // Elgato should see a refused/closed port as an RST, not a clean FIN.
        if (side === 'D' && other === client) reset(other);
        else other.destroy();
      }
    });
    sock.on('close', function onSockClose() {
      clearTimeout(connectTimer);
      if (!other.destroyed && !first) markClose(side, 'closed');
      onClose();
    });
  }
  wireSide('E', client, upstream);
  wireSide('D', upstream, client);

  upstream.once('connect', function onUpstreamConnect() {
    clearTimeout(connectTimer);
    const at = `${upstream.remoteAddress}:${upstream.remotePort}`;
    log(tag, `upstream connected ${at} in ${Date.now() - connectStart}ms`);
    client.on('data', function onClientData(chunk: Buffer) {
      toD += chunk.length;
      tapEtoD.feed(chunk);
    });
    upstream.on('data', function onUpstreamData(chunk: Buffer) {
      toE += chunk.length;
      tapDtoE.feed(chunk);
    });
    client.pipe(upstream);
    upstream.pipe(client);
  });
}

function startRelay(name: string, listenPort: number, targetPort: number, options: Options): void {
  const server = net.createServer({ allowHalfOpen: true, noDelay: true }, (client) => {
    handleConnection(name, client, options, targetPort);
  });
  server.on('error', (error) => {
    warn(name, `listener error: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(listenPort, options.listenHost, () => {
    log(
      name,
      `listening on ${options.listenHost}:${listenPort} -> ${options.targetHost}:${targetPort}`,
    );
  });
  servers.push(server);
}

function probeTarget(host: string, port: number): void {
  const probe = net.createConnection({ host, port });
  const timer = setTimeout(() => {
    warn('probe', `target NOT reachable: timeout after ${PROBE_TIMEOUT_MS}ms`);
    probe.destroy();
  }, PROBE_TIMEOUT_MS);
  probe.once('connect', () => {
    clearTimeout(timer);
    log('probe', `target reachable (${host}:${port})`);
    probe.end();
  });
  probe.once('error', (error: NodeJS.ErrnoException) => {
    clearTimeout(timer);
    warn('probe', `target NOT reachable: ${error.code ?? error.message}`);
  });
}

function printLocalAddresses(): void {
  const addrs: string[] = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) addrs.push(info.address);
    }
  }
  log('proxy', `add one of these in Elgato: ${addrs.length ? addrs.join(', ') : '(none found)'}`);
}

function startAdvertise(options: Options): void {
  const txt = [`dt=${MDNS_DT}`, `vid=${MDNS_VID}`, `pid=${options.pid}`, `sn=${options.sn}`];
  const args = ['-R', options.advertiseName, '_elg._tcp', '.', String(options.mainPort), ...txt];
  const proc = spawn('dns-sd', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  mdnsProc = proc;
  const pipeLines = (stream: NodeJS.ReadableStream, out: (m: string) => void): void => {
    let pending = '';
    stream.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) out(line.trimEnd());
    });
  };
  pipeLines(proc.stdout!, (m) => log('mdns', m));
  pipeLines(proc.stderr!, (m) => warn('mdns', m));
  proc.on('error', (error) => warn('mdns', `dns-sd failed to start: ${error.message}`));
  proc.on('exit', (code, signal) => {
    if (!shuttingDown)
      warn('mdns', `dns-sd exited (code=${code} signal=${signal}); still relaying`);
  });
}

function shutdown(signal: NodeJS.Signals): void {
  shuttingDown = true;
  log('proxy', `received ${signal}; closing proxy`);
  for (const server of servers) server.close();
  for (const session of [...sessions]) session.closeLocal();
  mdnsProc?.kill();
  setTimeout(() => process.exit(0), 250).unref();
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options) {
    if (options.advertise && process.platform !== 'darwin') {
      throw new Error('--advertise needs macOS Bonjour (dns-sd); not available on this platform');
    }
    startRelay('main', options.mainPort, options.targetMainPort, options);
    startRelay('child', options.childPort, options.targetChildPort, options);
    printLocalAddresses();
    probeTarget(options.targetHost, options.targetMainPort);
    if (options.advertise) startAdvertise(options);
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`\n${usage()}`);
  process.exitCode = 1;
}
