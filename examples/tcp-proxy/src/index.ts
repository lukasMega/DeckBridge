import net, { type Server, type Socket } from 'node:net';

interface Options {
  listenHost: string;
  targetHost: string;
  mainPort: number;
  childPort: number;
  targetMainPort: number;
  targetChildPort: number;
}

const CONNECT_TIMEOUT_MS = 5_000;
const activeSockets = new Set<Socket>();
const servers: Server[] = [];

function usage(): string {
  return [
    'Usage: node dist/index.js --target-host <mac-ip> [options]',
    '',
    'Options:',
    '  --listen-host <host>          Address to listen on (default: 127.0.0.1)',
    '  --main-port <port>            Proxy listen port (default: 5343)',
    '  --child-port <port>           Child proxy listen port (default: 5344)',
    '  --target-main-port <port>     DeckBridge main TCP port (default: 5343)',
    '  --target-child-port <port>    DeckBridge child TCP port (default: 5344)',
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
  const flags = new Set(['--help']);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (flags.has(arg)) {
      if (arg === '--help') {
        console.log(usage());
        return null;
      }
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    if (values.has(arg)) throw new Error(`Option specified more than once: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    values.set(arg, value);
  }

  const targetHost = values.get('--target-host');
  if (!targetHost) throw new Error('--target-host is required (the Mac running DeckBridge)');

  const options: Options = {
    listenHost: values.get('--listen-host') ?? '127.0.0.1',
    targetHost,
    mainPort: parsePort(values.get('--main-port'), '--main-port', 5343),
    childPort: parsePort(values.get('--child-port'), '--child-port', 5344),
    targetMainPort: parsePort(values.get('--target-main-port'), '--target-main-port', 5343),
    targetChildPort: parsePort(values.get('--target-child-port'), '--target-child-port', 5344),
  };

  for (const option of values.keys()) {
    if (![
      '--target-host',
      '--listen-host',
      '--main-port',
      '--child-port',
      '--target-main-port',
      '--target-child-port',
    ].includes(option)) {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  if (options.mainPort === options.childPort) {
    throw new Error('--main-port and --child-port must be different');
  }
  return options;
}

function startRelay(
  name: string,
  listenHost: string,
  listenPort: number,
  targetHost: string,
  targetPort: number,
): void {
  const server = net.createServer((client) => {
    activeSockets.add(client);
    client.once('close', () => activeSockets.delete(client));

    const upstream = net.createConnection({ host: targetHost, port: targetPort });
    activeSockets.add(upstream);
    upstream.once('close', () => activeSockets.delete(upstream));

    const connectTimer = setTimeout(() => {
      console.error(`[${name}] connection to ${targetHost}:${targetPort} timed out`);
      upstream.destroy(new Error('upstream connection timed out'));
    }, CONNECT_TIMEOUT_MS);
    connectTimer.unref();

    upstream.once('connect', () => {
      clearTimeout(connectTimer);
      console.log(`[${name}] relaying ${client.remoteAddress ?? 'client'} to ${targetHost}:${targetPort}`);
      client.pipe(upstream);
      upstream.pipe(client);
    });

    upstream.once('error', (error) => {
      clearTimeout(connectTimer);
      console.error(`[${name}] upstream error: ${error.message}`);
      client.destroy();
    });
    client.once('error', (error) => {
      console.error(`[${name}] client error: ${error.message}`);
      upstream.destroy();
    });
  });

  server.on('error', (error) => {
    console.error(`[${name}] listener error: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(listenPort, listenHost, () => {
    console.log(
      `[${name}] listening on ${listenHost}:${listenPort} -> ${targetHost}:${targetPort}`,
    );
  });
  servers.push(server);
}

function shutdown(signal: NodeJS.Signals): void {
  console.log(`Received ${signal}; closing proxy`);
  for (const server of servers) server.close();
  for (const socket of activeSockets) socket.destroy();
  setTimeout(() => process.exit(0), 250).unref();
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options) {
    startRelay('main', options.listenHost, options.mainPort, options.targetHost, options.targetMainPort);
    startRelay('child', options.listenHost, options.childPort, options.targetHost, options.targetChildPort);
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`\n${usage()}`);
  process.exitCode = 1;
}
