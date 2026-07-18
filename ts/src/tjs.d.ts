// Ambient declarations for txiki.js built-in modules.
// These are resolved natively at runtime; esbuild marks them external.
// Type stubs here are intentionally loose — add precision as needed.

// esbuild virtual module: the bundled mirabox USB worker, embedded as a string
// (see ts/build.mjs) and loaded into a Worker via a blob URL at runtime, so the
// compiled binary stays self-contained. (Declared here, not in globals.d.ts,
// because that file is a module — its ambient `declare module` blocks don't
// register globally; this file is a script, so these do.)
declare module 'virtual:mirabox-worker' {
  const s: string;
  export default s;
}

declare module 'virtual:native-libs' {
  export interface EmbeddedNativeLib {
    name: string;
    rawSize: number;
    gzB64: string;
  }
  export const NATIVE_LIBS: EmbeddedNativeLib[];
  export const NATIVE_LIBS_HASH: string;
}

// esbuild virtual module: the bundled generic HID USB worker (Mirabox + Elgato)
declare module 'virtual:hid-worker' {
  const s: string;
  export default s;
}

// esbuild virtual module: the bundled plugin worker (runs user plugin JS)
declare module 'virtual:plugin-worker' {
  const s: string;
  export default s;
}

declare module 'tjs:ffi' {
  export const suffix: string;

  export const types: {
    void: FfiType;
    uint8: FfiType;
    int8: FfiType;
    sint8: FfiType;
    uint16: FfiType;
    int16: FfiType;
    sint16: FfiType;
    uint32: FfiType;
    int32: FfiType;
    sint32: FfiType;
    uint64: FfiType;
    int64: FfiType;
    sint64: FfiType;
    float: FfiType;
    double: FfiType;
    pointer: FfiType;
    string: FfiType;
    buffer: FfiType;
    size: FfiType;
    ssize: FfiType;
    uchar: FfiType;
    schar: FfiType;
    ushort: FfiType;
    sshort: FfiType;
    uint: FfiType;
    sint: FfiType;
    ulong: FfiType;
    slong: FfiType;
    [k: string]: FfiType;
  };

  export interface FfiType {
    readonly size: number;
  }

  export interface NativePointer {
    toString(): string;
    equals(other: null | NativePointer): boolean;
    offset(byteCount: number): NativePointer;
    readonly isNull: boolean;
  }

  export interface StructInstance {
    [field: string]: unknown;
  }

  export class StructType {
    constructor(fields: [string, FfiType | StructType][], name?: string);
  }

  export class PointerType {
    constructor(type: FfiType | StructType, derefCount: number);
    deref(): StructInstance;
  }

  export class CFunction {
    constructor(
      symbol: DlSymbol,
      returnType: FfiType | PointerType,
      argTypes: (FfiType | PointerType)[],
    );
    call(...args: unknown[]): unknown;
  }

  export class Lib {
    constructor(libname: string);
    static readonly LIBC_NAME: string;
    symbol(name: string): DlSymbol;
    close(): void;
  }

  export interface DlSymbol {
    readonly addr: NativePointer;
  }

  export class Pointer {
    static createRef(type: FfiType, value: unknown): NativePointer;
  }

  type TypeAlias = string | FfiType | PointerType | StructType;

  export interface DlopenSymbolDef {
    args?: TypeAlias[];
    returns?: TypeAlias;
    fixed?: number;
  }

  export function dlopen<T extends Record<string, DlopenSymbolDef>>(
    path: string,
    symbols: T,
  ): {
    symbols: { [K in keyof T]: (...args: unknown[]) => unknown };
    close(): void;
  };

  const FFI: {
    suffix: typeof suffix;
    types: typeof types;
    Lib: typeof Lib;
    CFunction: typeof CFunction;
    StructType: typeof StructType;
    PointerType: typeof PointerType;
    Pointer: typeof Pointer;
    dlopen: typeof dlopen;
  };
  export default FFI;
}

// tjs:core/httpserver and tjs:core/sockets are NOT importable modules.
// Their functionality is exposed through the tjs global (tjs.serve, tjs.connect, tjs.listen).

declare module 'tjs:core/path' {
  export function join(...paths: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string, ext?: string): string;
  export function resolve(...paths: string[]): string;
}

declare module 'tjs:assert' {
  const assert: {
    ok(value: unknown, message?: string): void;
    eq(a: unknown, b: unknown, message?: string): void;
    equal(a: unknown, b: unknown, message?: string): void;
    notEqual(a: unknown, b: unknown, message?: string): void;
    deepEqual(a: unknown, b: unknown, message?: string): void;
    throws(fn: () => void, errorType?: unknown): void;
  };
  export default assert;
}

interface NetworkInterface {
  name: string;
  address: string;
  family: 'IPv4' | 'IPv6';
  internal: boolean;
  netmask?: string;
  mac?: string;
}

type StdioOption = 'pipe' | 'inherit' | 'ignore';

interface TjsSpawnOptions {
  stdin?: StdioOption;
  stdout?: StdioOption;
  stderr?: StdioOption;
  env?: Record<string, string>;
  cwd?: string;
}

interface TjsProcess {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly pid: number;
  wait(): Promise<{ exit_status: number; term_signal: string | null }>;
  kill(signal?: string): void;
}

interface TjsTCPOpenedInfo {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly localAddress: string;
  readonly localPort: number;
  readonly remoteAddress: string;
  readonly remotePort: number;
}

interface TjsTCPSocket {
  readonly opened: Promise<TjsTCPOpenedInfo>;
  readonly closed: Promise<void>;
  close(): void;
}

interface TjsAcceptedTCPSocket {
  readonly opened: Promise<TjsTCPOpenedInfo>;
  readonly closed: Promise<void>;
  close(): void;
}

interface TjsTCPServerOpenedInfo {
  readonly readable: ReadableStream<TjsAcceptedTCPSocket>;
  readonly localAddress: string;
  readonly localPort: number;
}

interface TjsTCPServerSocket {
  readonly opened: Promise<TjsTCPServerOpenedInfo>;
  readonly closed: Promise<void>;
  close(): void;
}

interface ServerWebSocket {
  readonly data: unknown;
  sendText(data: string): void;
  sendBinary(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

interface WebSocketHandlers {
  open?(ws: ServerWebSocket): void;
  message?(ws: ServerWebSocket, data: string): void;
  close?(ws: ServerWebSocket, code: number, reason: string): void;
  error?(ws: ServerWebSocket, error: Error): void;
}

interface TjsServeServer {
  stop(): void;
  upgrade(request: Request, options?: { data?: unknown }): boolean;
}

interface TjsServeOptions {
  port?: number;
  // The txiki.js native option is `listenIp`, not `host` (verified against
  // src/js/core/httpserver.js in the txiki.js source: it destructures
  // `listenIp = '0.0.0.0'` from the options object and never reads `host`) —
  // a `host` key here is silently ignored and the server always binds 0.0.0.0.
  listenIp?: string;
  websocket?: WebSocketHandlers;
  fetch(
    request: Request,
    extra: { server: TjsServeServer; remoteAddress: string },
  ): Response | Promise<Response> | void;
}

interface CpuInfo {
  readonly model: string;
  readonly speed: number;
}

// esbuild text loader: .html, .css, and .js files imported as strings
declare module '*.html' {
  const s: string;
  export default s;
}
declare module '*.css' {
  const s: string;
  export default s;
}
declare module '*.js' {
  const s: string;
  export default s;
}

declare const tjs: {
  readonly version: string;
  exit(code?: number): never;
  addSignalListener(signal: string, listener: () => void): void;
  removeSignalListener(signal: string, listener: () => void): void;
  readFile(path: string): Promise<Uint8Array>;
  readFile(path: string, options: { encoding: 'utf-8' } | 'utf-8'): Promise<string>;
  writeFile(path: string, data: Uint8Array | string, options?: { mode?: number }): Promise<void>;
  stat(
    path: string,
  ): Promise<{ isFile: boolean; isDirectory: boolean; size: number; mode: number }>;
  makeDir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  rename(path: string, newPath: string): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  readDir(
    path: string,
  ): Promise<AsyncIterableIterator<{ name: string; isFile: boolean; isDirectory: boolean }>>;
  readonly homeDir: string;
  readonly tmpDir: string;
  readonly exePath: string;
  readonly pid: number;
  readonly args: string[];
  spawn(args: string[], options?: TjsSpawnOptions): TjsProcess;
  readonly env: Record<string, string>;
  readonly system: {
    readonly networkInterfaces: NetworkInterface[];
    readonly cpus: CpuInfo[];
  };
  connect(transport: 'tcp', host: string, port: number): Promise<TjsTCPSocket>;
  listen(transport: 'tcp', host: string, port: number): Promise<TjsTCPServerSocket>;
  serve(options: TjsServeOptions): TjsServeServer;
};

// Augment the existing navigator global (from lib.dom.d.ts) instead of redeclaring it.
// Optional: a txiki build may lack userAgentData entirely (E9) — guard accesses.
interface Navigator {
  readonly userAgentData?: { readonly platform: string };
}

declare namespace NodeJS {
  // In txiki.js, setInterval/setTimeout return numbers, not Node.js Timer objects
  type Timeout = ReturnType<typeof setInterval>;
}
