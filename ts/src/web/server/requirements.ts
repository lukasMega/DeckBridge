import FFI from 'tjs:ffi';
import { getHidapiSystemCandidates } from '../../ffi/hidapi';
import { isNativeMdnsAvailable } from '../../ffi/mdns';
import { resolveTrayBin } from '../../tray.js';

export interface RequirementResult {
  name: string;
  ok: boolean;
  message: string;
  installHint?: string;
}

function notFoundMsg(value: string, envVar: string): string {
  return value ? `Not found: ${value}` : `Not found (${envVar} not set)`;
}

/** Run `argv` silently: true on exit 0, false on any other exit, null when the
 *  spawn itself failed (binary missing / not permitted). */
async function spawnOk(argv: string[]): Promise<boolean | null> {
  try {
    const { exit_status } = await tjs.spawn(argv, { stdout: 'ignore', stderr: 'ignore' }).wait();
    return exit_status === 0;
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  // Windows has no `test` built-in; use cmd /c if exist instead.
  const argv =
    FFI.suffix === 'dll'
      ? ['cmd', '/c', `if exist "${path}" (exit 0) else (exit 1)`]
      : ['test', '-f', path];
  return (await spawnOk(argv)) === true;
}

function binaryResult(
  name: string,
  path: string,
  ok: boolean,
  notFound: string,
  installHint: string,
): RequirementResult {
  return {
    name,
    ok,
    message: ok ? `Found: ${path}` : notFound,
    installHint: ok ? undefined : installHint,
  };
}

async function checkBinary(
  name: string,
  envVar: string,
  installHint: string,
): Promise<RequirementResult> {
  const path = tjs.env[envVar] ?? '';
  const ok = path !== '' && (await fileExists(path));
  return binaryResult(name, path, ok, notFoundMsg(path, envVar), installHint);
}

// Not checkBinary(): the tray is found via $DECKBRIDGE_TRAY_BIN *or* a sidecar
// next to the executable, which is how every packaged release ships it. Checking
// only the env var reported "Not found" while the tray was visibly running.
async function checkTray(): Promise<RequirementResult> {
  const path = await resolveTrayBin();
  const ok = path !== '' && (await fileExists(path));
  return binaryResult(
    'tray',
    path,
    ok,
    'Not found (no deckbridge-tray next to the executable, DECKBRIDGE_TRAY_BIN not set)',
    'Run: mise run tray-rs',
  );
}

function checkLibhidapi(): Promise<RequirementResult> {
  const bundled = tjs.env.HIDAPI_LIB ?? '';
  const candidates = bundled
    ? [bundled, ...getHidapiSystemCandidates()]
    : getHidapiSystemCandidates();
  for (const path of candidates) {
    try {
      const lib = FFI.dlopen(path, {});
      lib.close();
      return Promise.resolve({
        name: 'libhidapi',
        ok: true,
        message: path === bundled ? `Found (bundled): ${path}` : `Found: ${path}`,
      });
    } catch {
      /* try next */
    }
  }
  return Promise.resolve({
    name: 'libhidapi',
    ok: false,
    message: 'Not found',
    installHint: 'macOS: brew install hidapi | Linux: sudo apt install libhidapi-dev',
  });
}

// mDNS: built-in on macOS (Bonjour) and Windows (native since Win10 1803),
// requires avahi-daemon on Linux
async function checkMdns(): Promise<RequirementResult> {
  if (FFI.suffix === 'dylib') {
    return { name: 'mdns', ok: true, message: 'Built into macOS (Bonjour)' };
  }
  if (FFI.suffix === 'dll') {
    if (isNativeMdnsAvailable()) {
      return {
        name: 'mdns',
        ok: true,
        message: 'Native mDNS advertise available (Windows Dnsapi)',
      };
    }
    const dnsSd = (await spawnOk(['cmd', '/c', 'where dns-sd'])) === true;
    return {
      name: 'mdns',
      ok: dnsSd,
      message: dnsSd
        ? 'Native mDNS unavailable — using dns-sd (Bonjour) fallback'
        : 'No mDNS advertise path available (native failed, dns-sd/Bonjour not found)',
      installHint: dnsSd
        ? undefined
        : 'Install Bonjour Print Services for Windows for the dns-sd fallback',
    };
  }
  const ok = await spawnOk(['pgrep', 'avahi-daemon']);
  if (ok === null) return { name: 'mdns', ok: false, message: 'Cannot check avahi-daemon' };
  return {
    name: 'mdns',
    ok,
    message: ok ? 'avahi-daemon running' : 'avahi-daemon not running',
    installHint: ok
      ? undefined
      : 'sudo apt install avahi-daemon && sudo systemctl start avahi-daemon',
  };
}

export async function checkRequirements(): Promise<RequirementResult[]> {
  return [
    await checkBinary(
      'deckbridge_native',
      'DECKBRIDGE_NATIVE_LIB',
      'Run: mise run deckbridge-native',
    ),
    await checkTray(),
    await checkLibhidapi(),
    await checkMdns(),
  ];
}
