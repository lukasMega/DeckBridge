import type { PairingProbe, PairingRoute } from '../../ui-types.js';

export interface RouteCost {
  ram: string;
  disk: string;
  time: string;
  money: string;
  needs: string;
}

type RealRoute = Exclude<PairingRoute, 'none'>;

export const ROUTE_COSTS: Record<RealRoute, RouteCost> = {
  downgrade: {
    ram: 'none',
    disk: 'none',
    time: '~5 min',
    money: 'free',
    needs: 'Turn off app updates. You miss newer app fixes.',
  },
  device: {
    ram: '~15 MB on that device',
    disk: '~30 MB',
    time: '~5 min',
    money: 'free if you own one (Raspberry Pi Zero 2 W ~$15)',
    needs: '64-bit Linux, macOS or Windows; stays on',
  },
  wsl: {
    ram: '~300–600 MB while on',
    disk: '~1.5–2 GB',
    time: '~2 min, or 15 min + restart',
    money: 'free',
    needs: 'Windows 10 2004+ or 11',
  },
  container: {
    ram: '≤ 256 MB',
    disk: '~100 MB',
    time: '~5 min',
    money: 'free',
    needs: 'macOS 26, Apple silicon, admin password once',
  },
  orbstack: {
    ram: '~150 MB–1 GB',
    disk: '~0.8 GB',
    time: '~5 min',
    money: 'free for personal use; $8/month commercial',
    needs: 'macOS',
  },
};

export interface RouteOption {
  route: RealRoute;
  title: string;
  sub: string;
  cost: RouteCost;
  /** Probe-based readiness, e.g. 'Ready: Ubuntu-24.04 (WSL 2)'; null when not applicable. */
  badge: string | null;
  disabled: boolean;
  recommended: boolean;
}

/** Phase gate: P1 offers downgrade, device, wsl and a manual orbstack; P3 adds container. */
export const ENABLED_ROUTES: ReadonlySet<PairingRoute> = new Set([
  'downgrade',
  'device',
  'wsl',
  'orbstack',
]);

const TEXT: Record<RealRoute, { title: string; sub: string }> = {
  downgrade: {
    title: 'Use Stream Deck app 7.6.0',
    sub: 'No relay. Install the older app and turn off updates.',
  },
  device: {
    title: 'Relay on another device',
    sub: 'A Raspberry Pi, Linux PC, Mac or Windows PC on this network.',
  },
  wsl: {
    title: 'Relay in WSL on this PC',
    sub: 'A small Linux system inside Windows runs the relay.',
  },
  container: {
    title: 'Relay in Apple container on this Mac',
    sub: "Apple's free tool runs the relay in a tiny Linux VM.",
  },
  orbstack: {
    title: 'Relay in OrbStack on this Mac',
    sub: 'OrbStack runs the relay in a small Linux machine.',
  },
};

export function isRelayRoute(r: PairingRoute): boolean {
  return r === 'wsl' || r === 'device' || r === 'container' || r === 'orbstack';
}

const NOT_INSTALLED_5 = 'Not installed: about 5 min';

function wslBadge(probe: PairingProbe): { badge: string; ready: boolean } {
  const distros = probe.wsl?.distros ?? [];
  const v2 = distros.filter((d) => d.version === 2);
  const pick = v2.find((d) => d.isDefault) ?? v2[0];
  if (pick) return { badge: `Ready: ${pick.name} (WSL 2)`, ready: true };
  if (distros.length > 0) return { badge: 'WSL 1 found: needs WSL 2', ready: false };
  return { badge: 'Not installed: about 15 min + restart', ready: false };
}

function macSupportsContainer(probe: PairingProbe): boolean {
  const m = probe.mac;
  return m !== null && m.arch === 'arm64' && Number.parseInt(m.version, 10) >= 26;
}

interface Eval {
  badge: string | null;
  disabled: boolean;
  ready: boolean;
}

function evaluate(route: RealRoute, probe: PairingProbe): Eval {
  if (route === 'wsl') {
    const w = wslBadge(probe);
    return { badge: w.badge, disabled: false, ready: w.ready };
  }
  if (route === 'container') {
    if (!macSupportsContainer(probe)) {
      return { badge: 'Needs macOS 26 on Apple silicon', disabled: true, ready: false };
    }
    const installed = probe.mac?.container === true;
    return { badge: installed ? 'Installed' : NOT_INSTALLED_5, disabled: false, ready: installed };
  }
  if (route === 'orbstack') {
    const installed = probe.mac?.orbstack === true;
    return { badge: installed ? 'Installed' : NOT_INSTALLED_5, disabled: false, ready: installed };
  }
  return { badge: null, disabled: false, ready: false };
}

function sameComputerRoutes(probe: PairingProbe, enabled: ReadonlySet<PairingRoute>): RealRoute[] {
  let all: RealRoute[] = [];
  if (probe.platform === 'Windows') all = ['wsl'];
  else if (probe.platform === 'macOS') all = ['container', 'orbstack'];
  return all.filter((r) => enabled.has(r));
}

function pickRecommended(
  routes: RealRoute[],
  evals: Map<RealRoute, Eval>,
  probe: PairingProbe,
): RealRoute | null {
  const ready = routes.find((r) => evals.get(r)?.ready === true && !evals.get(r)?.disabled);
  if (ready) return ready;
  if (routes.includes('wsl')) return 'wsl';
  if (routes.includes('container') && macSupportsContainer(probe)) return 'container';
  return routes.includes('orbstack') ? 'orbstack' : null;
}

/** `enabled` defaults to the phase gate; tests pass a wider set. */
export function routeOptions(
  probe: PairingProbe,
  otherDevice: boolean,
  enabled: ReadonlySet<PairingRoute> = ENABLED_ROUTES,
): RouteOption[] {
  const local = sameComputerRoutes(probe, enabled);
  const evals = new Map<RealRoute, Eval>(local.map((r) => [r, evaluate(r, probe)]));
  const recommended: RealRoute | null = otherDevice
    ? 'device'
    : pickRecommended(local, evals, probe);
  const order: RealRoute[] = ['downgrade'];
  if (otherDevice && enabled.has('device')) order.push('device');
  order.push(...local);
  return order.map((route) => {
    const e = evals.get(route) ?? evaluate(route, probe);
    return {
      route,
      ...TEXT[route],
      cost: ROUTE_COSTS[route],
      badge: e.badge,
      disabled: e.disabled,
      recommended: route === recommended,
    };
  });
}
