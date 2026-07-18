import FFI from 'tjs:ffi';
import { getHidapiSystemCandidates } from '../../ffi/hidapi';
import { isNativeMdnsAvailable } from '../../ffi/mdns';

export interface RequirementResult {
  name: string;
  ok: boolean;
  message: string;
  installHint?: string;
}

function notFoundMsg(value: string, envVar: string): string {
  return value ? `Not found: ${value}` : `Not found (${envVar} not set)`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    // Windows has no `test` built-in; use cmd /c if exist instead.
    const p =
      FFI.suffix === 'dll'
        ? tjs.spawn(['cmd', '/c', `if exist "${path}" (exit 0) else (exit 1)`], {
            stdout: 'ignore',
            stderr: 'ignore',
          })
        : tjs.spawn(['test', '-f', path], { stdout: 'ignore', stderr: 'ignore' });
    const { exit_status } = await p.wait();
    return exit_status === 0;
  } catch {
    return false;
  }
}

async function checkBinary(
  name: string,
  envVar: string,
  installHint: string,
): Promise<RequirementResult> {
  const path = tjs.env[envVar] ?? '';
  const ok = path !== '' && (await fileExists(path));
  return {
    name,
    ok,
    message: ok ? `Found: ${path}` : notFoundMsg(path, envVar),
    installHint: ok ? undefined : installHint,
  };
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

async function dnsSdOnPath(): Promise<boolean> {
  try {
    const p = tjs.spawn(['cmd', '/c', 'where dns-sd'], { stdout: 'ignore', stderr: 'ignore' });
    const { exit_status } = await p.wait();
    return exit_status === 0;
  } catch {
    return false;
  }
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
    const dnsSd = await dnsSdOnPath();
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
  try {
    const p = tjs.spawn(['pgrep', 'avahi-daemon'], { stdout: 'ignore', stderr: 'ignore' });
    const { exit_status } = await p.wait();
    const ok = exit_status === 0;
    return {
      name: 'mdns',
      ok,
      message: ok ? 'avahi-daemon running' : 'avahi-daemon not running',
      installHint: ok
        ? undefined
        : 'sudo apt install avahi-daemon && sudo systemctl start avahi-daemon',
    };
  } catch {
    return { name: 'mdns', ok: false, message: 'Cannot check avahi-daemon' };
  }
}

export async function checkRequirements(): Promise<RequirementResult[]> {
  return [
    await checkBinary(
      'deckbridge_native',
      'DECKBRIDGE_NATIVE_LIB',
      'Run: mise run deckbridge-native',
    ),
    await checkBinary('tray', 'DECKBRIDGE_TRAY_BIN', 'Run: mise run tray-rs'),
    await checkLibhidapi(),
    await checkMdns(),
  ];
}
