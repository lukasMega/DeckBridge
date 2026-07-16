import {
  MDNS_PROTOCOL,
  MDNS_SERVICE_NAME,
  MDNS_SERVICE_TYPE,
  MDNS_TXT_DEVICE_TYPE,
  MDNS_TXT_VID,
} from './types.js';
import { platformName } from './os-utils.ts';

type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

export function buildArgs(
  platform: string,
  name: string,
  port: number,
  txt: Record<string, string>,
): string[] {
  const txtArgs = Object.entries(txt).map(([k, v]) => `${k}=${v}`);
  if (platform === 'Linux') {
    // avahi-publish-service <name> <type> <port> [txt...]
    return [
      'avahi-publish-service',
      name,
      `_${MDNS_SERVICE_TYPE}._${MDNS_PROTOCOL}`,
      String(port),
      ...txtArgs,
    ];
  }
  // macOS and Windows: dns-sd -R <name> <type> <domain> <port> [txt...]
  return [
    'dns-sd',
    '-R',
    name,
    `_${MDNS_SERVICE_TYPE}._${MDNS_PROTOCOL}`,
    '.',
    String(port),
    ...txtArgs,
  ];
}

export class MdnsAdvertiser {
  private proc: TjsProcess | null = null;
  private readonly log: LogFn;
  readonly port: number;
  private readonly serviceName: string;
  private productId = 0;
  private serialNumber = '';

  constructor(port: number, log: LogFn, serviceName: string = MDNS_SERVICE_NAME) {
    this.port = port;
    this.log = log;
    this.serviceName = serviceName;
  }

  updateIdentity(productId: number, serialNumber: string): void {
    this.productId = productId;
    this.serialNumber = serialNumber;
  }

  start(): Promise<void> {
    try {
      const platform = platformName();
      const txt = {
        dt: MDNS_TXT_DEVICE_TYPE,
        vid: MDNS_TXT_VID,
        pid: String(this.productId),
        sn: this.serialNumber,
      };
      const args = buildArgs(platform, this.serviceName, this.port, txt);

      this.log('info', `mDNS: spawning ${args[0]} for ${this.serviceName} on port ${this.port}`);

      const proc = tjs.spawn(args, { stderr: 'inherit' });
      this.proc = proc;
      // Don't await wait() — process runs until stop() kills it
      void proc.wait().then((result) => {
        if (result.exit_status !== 0 && this.proc === proc) {
          this.log('warn', `mDNS subprocess exited unexpectedly (status=${result.exit_status})`);
        }
        return undefined;
      });
    } catch (e) {
      this.log(
        'warn',
        `mDNS subprocess failed to start (${(e as Error).message}); running without mDNS discovery`,
      );
    }
    return Promise.resolve();
  }

  stop(): void {
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        // already exited
      }
      this.proc = null;
    }
  }
}
