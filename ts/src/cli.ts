/** CLI argument parsing. Hand-rolled, zero dependencies (see CLAUDE.md boundaries —
 *  this file is classified 'shared' and must not import anything else in the tree). */

export type CliCommand = 'run' | 'devices' | 'diagnose' | 'version' | 'help';

export interface CliFlags {
  mock: boolean;
  bind?: string;
  webuiPort?: number;
  noWebui: boolean;
  open: boolean;
  headless: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  cacheDir?: string;
  /** `diagnose`: replace extra-key commands/plugin args with "<redacted>". Off by
   *  default — a redacted field is precisely the one needed when an extra-key
   *  widget is the bug. See docs/troubleshooting.md. */
  redactCommands: boolean;
  /** `diagnose`: write the report here instead of the default cache location. */
  out?: string;
  /** `run`: ignore settings.json's `modelOverrides` for this session (safe mode
   *  — a bad keyMap override can make a device look dead). */
  noOverrides: boolean;
  /** `run`: never send the daily usage ping (telemetry-env.ts). Same effect as
   *  `DECKBRIDGE_NO_TELEMETRY=1` or settings.json `"a7s": false`. */
  noTelemetry: boolean;
}

export interface ParsedCli {
  command: CliCommand;
  flags: CliFlags;
}

export type CliParseResult = { ok: true; cli: ParsedCli } | { ok: false; error: string };

const COMMANDS = ['run', 'devices', 'diagnose', 'version', 'help'] as const;
/** Single source of truth for the accepted levels — reused by the persisted-settings
 *  guard and POST /api/log-level so the three can't drift apart. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type CliLogLevel = (typeof LOG_LEVELS)[number];

export function isLogLevel(v: unknown): v is CliLogLevel {
  return typeof v === 'string' && (LOG_LEVELS as readonly string[]).includes(v);
}

export const USAGE_TEXT = `Usage: deckbridge [command] [flags]

Commands:
  run                 Start the bridge (default when no command given)
  devices             List detected stream deck HID devices, then exit
  diagnose            Write a diagnostics report (for bug reports), then exit
  version             Print version/build info, then exit
  help                Print usage, then exit

Flags (for run):
  --mock                    Start with the mock driver (no hardware)
  --bind <addr>             Listen address for CORA + WebUI  [default 0.0.0.0]
  --webui-port <n>          WebUI HTTP/WS port               [default 3000]
  --no-webui                Do not start the WebUI server
  --open                    Auto-open browser (desktop convenience)
  --headless                Shorthand: no tray, no browser open, skip Elgato-app poll
  --log-level <lvl>         debug|info|warn|error|silent (runtime override)
  --no-overrides            Safe mode: ignore settings.json modelOverrides
  --no-telemetry            Never send the daily ping
  --cache-dir <path>        Settings + native-lib extraction root (default: XDG cache dir)
  -h, --help                Show this help
  -V, --version             Show version

Flags (for diagnose):
  --out <path>              Write the report here instead of the cache dir
  --redact-commands         Replace extra-key commands/plugin args with <redacted>

Log level precedence: --log-level > $DECKBRIDGE_LOG_LEVEL > settings.json
"logLevel" > the level baked in at build time.`;

/** True in safe mode (`run --no-overrides` / DECKBRIDGE_NO_OVERRIDES=1): device
 *  tuning stays persisted but is ignored for this session. Read live, not at
 *  module load, so the WebUI reports the same answer the DriverManager acts on. */
export function overridesDisabled(): boolean {
  return typeof tjs !== 'undefined' && tjs.env.DECKBRIDGE_NO_OVERRIDES === '1';
}

export function versionText(): string {
  return `deckbridge ${__VERSION__} (built ${__BUILD_TIME__})`;
}

/** `tjs.args` shape differs by invocation:
 *    tjs run ts/dist/bundle.js --mock  → [tjs, run, bundle.js, --mock]
 *    ./deckbridge --mock               → [deckbridge, --mock]
 *    ./deckbridge run --mock           → [deckbridge, run, --mock]
 *  Strips the runtime prefix so callers only ever see the user-supplied flags.
 *
 *  `args[1] === 'run'` alone can't tell the first shape from the third — and
 *  treating the third as the first ate the `run` word AND the flag after it, so
 *  `./deckbridge run --mock --headless` silently started without the mock driver.
 *  The script path is the discriminator: txiki's `run` always takes one, and our
 *  own `run` command never does.
 *
 *  `raw` defaults to tjs.args (frozen/non-configurable at runtime — can't be mutated
 *  in place), overridable so tests can exercise every shape without touching the global. */
export function userArgs(raw: string[] = tjs.args): string[] {
  const isRuntimePrefix = raw[1] === 'run' && raw[2] !== undefined && raw[2].endsWith('.js');
  return isRuntimePrefix ? raw.slice(3) : raw.slice(1);
}

/** First token, if it's a bare command word (not a `-`-prefixed flag). Returns
 *  how many leading args it consumed (0 or 1) so the flag loop knows where to start. */
function parseCommandWord(
  args: string[],
): { command: CliCommand; consumed: number } | { error: string } {
  if (args.length === 0 || args[0]!.startsWith('-')) return { command: 'run', consumed: 0 };
  const word = args[0]!;
  if (!(COMMANDS as readonly string[]).includes(word))
    return { error: `unknown command '${word}'` };
  return { command: word as CliCommand, consumed: 1 };
}

/** Derived so a typo'd flag target is a compile error, not a silent no-op. */
type BooleanFlagKey = {
  [K in keyof CliFlags]: CliFlags[K] extends boolean ? K : never;
}[keyof CliFlags];

/** Flags that take no value — just set their boolean. */
const BOOLEAN_FLAGS: Record<string, BooleanFlagKey> = {
  '--mock': 'mock',
  '--no-webui': 'noWebui',
  '--open': 'open',
  '--headless': 'headless',
  '--redact-commands': 'redactCommands',
  '--no-overrides': 'noOverrides',
  '--no-telemetry': 'noTelemetry',
};

/** Flags that consume the following arg as a value. Returns an error message,
 *  or undefined on success. */
const VALUE_FLAGS: Record<string, (flags: CliFlags, value: string) => string | undefined> = {
  '--bind': (f, v) => {
    f.bind = v;
    return undefined;
  },
  '--webui-port': (f, v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) return '--webui-port requires a positive integer';
    f.webuiPort = n;
    return undefined;
  },
  '--log-level': (f, v) => {
    if (!isLogLevel(v)) return `--log-level must be one of ${LOG_LEVELS.join('|')}`;
    f.logLevel = v;
    return undefined;
  },
  '--out': (f, v) => {
    f.out = v;
    return undefined;
  },
  '--cache-dir': (f, v) => {
    f.cacheDir = v;
    return undefined;
  },
};

/** `-h`/`--help` and `-V`/`--version` may appear anywhere and override the
 *  command (matching common CLI convention). */
const COMMAND_OVERRIDE_FLAGS: Record<string, CliCommand> = {
  '-h': 'help',
  '--help': 'help',
  '-V': 'version',
  '--version': 'version',
};

type FlagsParseResult =
  | { ok: true; flags: CliFlags; commandOverride: CliCommand | null }
  | { ok: false; error: string };

function parseFlagArgs(args: string[], startIndex: number): FlagsParseResult {
  const flags: CliFlags = {
    mock: false,
    noWebui: false,
    open: false,
    headless: false,
    redactCommands: false,
    noOverrides: false,
    noTelemetry: false,
  };
  let commandOverride: CliCommand | null = null;

  for (let i = startIndex; i < args.length; i++) {
    const a = args[i]!;
    const overrideCommand = COMMAND_OVERRIDE_FLAGS[a];
    const booleanKey = BOOLEAN_FLAGS[a];
    const setValue = VALUE_FLAGS[a];
    if (overrideCommand) {
      commandOverride = overrideCommand;
    } else if (booleanKey) {
      flags[booleanKey] = true;
    } else if (setValue) {
      const v = args[++i];
      if (v === undefined) return { ok: false, error: `${a} requires a value` };
      const error = setValue(flags, v);
      if (error !== undefined) return { ok: false, error };
    } else {
      return { ok: false, error: `unknown flag '${a}'` };
    }
  }

  return { ok: true, flags, commandOverride };
}

/** Pure parser — returns an error instead of exiting, so it's unit-testable. */
export function parseCliArgs(args: string[]): CliParseResult {
  const word = parseCommandWord(args);
  if ('error' in word) return { ok: false, error: word.error };

  const parsedFlags = parseFlagArgs(args, word.consumed);
  if (!parsedFlags.ok) return parsedFlags;

  return {
    ok: true,
    cli: { command: parsedFlags.commandOverride ?? word.command, flags: parsedFlags.flags },
  };
}

/** Thin wrapper around parseCliArgs: prints usage + error and exits 2 on a parse
 *  failure. Kept separate from parseCliArgs so tests can exercise the parser
 *  without killing the test process. */
export function parseCli(args: string[]): ParsedCli {
  const result = parseCliArgs(args);
  if (result.ok) return result.cli;
  console.error(`deckbridge: ${result.error}\n`);
  console.error(USAGE_TEXT);
  tjs.exit(2);
}

/** Normalizes CLI flags into tjs.env so downstream code (main thread + hid-worker —
 *  env is process-wide across txiki threads) keeps its existing env reads. Only sets
 *  a var when the flag was actually given, so precedence is CLI flag > pre-existing
 *  env var > default. */
export function applyFlagsToEnv(flags: CliFlags): void {
  if (flags.mock) tjs.env.DECKBRIDGE_MOCK = '1';
  if (flags.bind !== undefined) tjs.env.DECKBRIDGE_BIND = flags.bind;
  if (flags.open) tjs.env.DECKBRIDGE_OPEN = '1';
  if (flags.webuiPort !== undefined) tjs.env.DECKBRIDGE_WEBUI_PORT = String(flags.webuiPort);
  if (flags.headless) tjs.env.DECKBRIDGE_HEADLESS = '1';
  if (flags.cacheDir !== undefined) tjs.env.DECKBRIDGE_CACHE_DIR = flags.cacheDir;
  if (flags.logLevel !== undefined) tjs.env.DECKBRIDGE_LOG_LEVEL = flags.logLevel;
  if (flags.noOverrides) tjs.env.DECKBRIDGE_NO_OVERRIDES = '1';
  if (flags.noTelemetry) tjs.env.DECKBRIDGE_NO_TELEMETRY = '1';
}
