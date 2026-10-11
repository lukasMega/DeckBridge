// Build-time stand-in for 'preact', 'preact/hooks' and 'preact/jsx-runtime' in an
// extension's ui.js (ts/scripts/build-extensions.mjs aliases them here). Every call goes
// to the WebUI's own Preact from mount()'s api: a second copy would break hooks.
import type { ComponentChildren } from 'preact';
import type { ExtensionUiApi } from '../../extension/api.js';

type AnyFn = (...args: unknown[]) => unknown;
type Hooks = ExtensionUiApi['hooks'];
type Preact = ExtensionUiApi['preact'];

let host: ExtensionUiApi | undefined;

/** Call first in mount(), before rendering anything. */
export function bindHost(api: ExtensionUiApi): void {
  host = api;
}

function bound(): ExtensionUiApi {
  if (!host) throw new Error('extension UI rendered before mount()');
  return host;
}

const hook = <K extends keyof Hooks>(name: K): Hooks[K] =>
  ((...args: unknown[]) => (bound().hooks[name] as AnyFn)(...args)) as Hooks[K];

export const useState = /* @__PURE__ */ hook('useState');
export const useEffect = /* @__PURE__ */ hook('useEffect');
export const useRef = /* @__PURE__ */ hook('useRef');
export const useMemo = /* @__PURE__ */ hook('useMemo');
export const useCallback = /* @__PURE__ */ hook('useCallback');

export const h = ((...args: unknown[]) => (bound().preact.h as AnyFn)(...args)) as Preact['h'];
export const render = ((...args: unknown[]) =>
  (bound().preact.render as AnyFn)(...args)) as Preact['render'];

/** Preact treats any function component returning its children as a fragment. */
export function Fragment(props: { children?: ComponentChildren }): ComponentChildren {
  return props.children;
}

/** The automatic JSX runtime: children already sit in props. */
export function jsx(type: unknown, props: Record<string, unknown>, key?: unknown): unknown {
  return (h as AnyFn)(type, key === undefined ? props : { ...props, key });
}
export { jsx as jsxs, jsx as jsxDEV };
