// Screen-on and full-screen helpers. All feature-detected: the page is served over plain HTTP
// on the LAN, where the Wake Lock API does not exist (it needs a secure context).
interface WakeLockSentinelLike {
  release(): Promise<void>;
}
interface WakeLockApi {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => void };
type FsDocument = Document & { webkitFullscreenEnabled?: boolean };

export function wakeLockSupported(): boolean {
  return 'wakeLock' in navigator;
}

/** Acquires the lock; returns a release function, or null when unavailable or refused. */
export async function requestWakeLock(): Promise<(() => void) | null> {
  if (!wakeLockSupported()) return null;
  try {
    const lock = await (navigator as Navigator & { wakeLock: WakeLockApi }).wakeLock.request(
      'screen',
    );
    return (): void => void lock.release().catch(() => undefined);
  } catch {
    return null;
  }
}

export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

export function fullscreenSupported(): boolean {
  const doc = document as FsDocument;
  const el = document.documentElement as FsElement;
  const can = doc.fullscreenEnabled || doc.webkitFullscreenEnabled === true;
  return can && (typeof el.requestFullscreen === 'function' || !!el.webkitRequestFullscreen);
}

export function requestFullscreen(): void {
  const el = document.documentElement as FsElement;
  if (typeof el.requestFullscreen === 'function')
    void el.requestFullscreen().catch(() => undefined);
  else el.webkitRequestFullscreen?.();
}
