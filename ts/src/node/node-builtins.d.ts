// Only the Node.js API the relay shim uses. @types/node would add Node globals
// (process, Buffer) to every tjs file in src/, so they stay out.

declare module 'node:net' {
  interface Socket {
    readonly remoteAddress?: string;
    readonly remotePort?: number;
    readonly localAddress?: string;
    readonly localPort?: number;
    once(event: 'connect', fn: () => void): this;
    once(event: 'error', fn: (e: Error) => void): this;
    off(event: 'error', fn: (e: Error) => void): this;
    on(event: 'data', fn: (chunk: Uint8Array) => void): this;
    on(event: 'end' | 'close', fn: () => void): this;
    on(event: 'error', fn: (e: Error) => void): this;
    pause(): this;
    resume(): this;
    write(chunk: Uint8Array, cb: (e?: Error | null) => void): boolean;
    end(cb: (e?: Error | null) => void): this;
    destroy(): void;
  }
  interface Server {
    once(event: 'error', fn: (e: Error) => void): this;
    off(event: 'error', fn: (e: Error) => void): this;
    on(event: 'error', fn: (e: Error) => void): this;
    on(event: 'connection', fn: (s: Socket) => void): this;
    listen(port: number, host: string, cb: () => void): this;
    address(): { address: string; port: number } | string | null;
    close(): this;
  }
  interface SocketOptions {
    allowHalfOpen?: boolean;
    noDelay?: boolean;
    keepAlive?: boolean;
    keepAliveInitialDelay?: number;
  }
  function connect(opts: SocketOptions & { host: string; port: number }): Socket;
  function createServer(opts: SocketOptions): Server;
}

declare module 'node:os' {
  interface NodeInterface {
    address: string;
    netmask: string;
    mac: string;
    internal: boolean;
    scopeid?: number;
  }
  function networkInterfaces(): Record<string, NodeInterface[] | undefined>;
}

declare module 'node:process' {
  const process: {
    readonly env: Record<string, string | undefined>;
    readonly pid: number;
    readonly argv: string[];
    readonly versions: { readonly node: string };
    exitCode: number | undefined;
    exit(code?: number): never;
    on(signal: string, fn: () => void): void;
    off(signal: string, fn: () => void): void;
  };
  export default process;
}
