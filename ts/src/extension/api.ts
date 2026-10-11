// Public extension API, v1: what an extension's server.js and ui.js receive and return.
// Extension packages import it type-only; see docs/extensions.md.
import type { ComponentChildren } from 'preact';
import type { DockStatus, KeyState } from '../web/contract.js';

export type { KeyState };

/** manifest.json `apiVersion` this DeckBridge loads; any other value is rejected. */
export const EXTENSION_API_VERSION = 1;

export interface ExtensionManifest {
  /** Must equal the extension's folder name: lowercase letters, digits, dashes. */
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  description?: string;
  /** A WebUI page: a topbar button opens it and ui.js mounts into its body. */
  page?: { title: string; /** Inline SVG markup for the button. */ icon?: string };
}

/** Where a deck's input comes from. */
export type DeckSource = 'usb' | 'browser' | 'mock';

/** One device input, seen before standby or knob routing (a waking press is included). */
export type ExtensionInput =
  | { kind: 'key'; mk2: number; state: KeyState }
  | { kind: 'extraKey'; wireId: number; state: KeyState }
  | { kind: 'dialPress'; index: number; state: KeyState }
  | { kind: 'dialRotate'; index: number; delta: number }
  | { kind: 'touch' };

/** `at` is epoch ms. A reconnect is a second deckAttached for a known deviceKey. */
export type ExtensionEvent =
  | {
      type: 'deckAttached';
      at: number;
      deviceKey: string;
      modelName: string;
      source: DeckSource;
      hasEncoders: boolean;
      /** Columns of the key grid the Elgato app sees (mk2 index = row * columns + column). */
      columns: number;
      /** Side-key wire ids in panel order. */
      extraKeys: number[];
    }
  | { type: 'input'; at: number; deviceKey: string; input: ExtensionInput }
  /** A key image was transformed and written; `cached` = served by the image cache. */
  | { type: 'imageProcessed'; at: number; deviceKey: string; cached: boolean };

/** A call to /api/ext/<id>/<path>; `path` is the single segment after the id. */
export interface ExtensionRequest {
  method: 'GET' | 'POST';
  path: string;
  query: Record<string, string>;
  /** Parsed JSON body of a POST; undefined when there is none. */
  body?: unknown;
}

/** `body` is sent as JSON; it must be structured-cloneable. */
export interface ExtensionResponse {
  status?: number;
  body: unknown;
}

export interface ExtensionContext {
  readonly id: string;
  /** DeckBridge process start, epoch ms; the extension may have started later. */
  readonly appStartedAt: number;
  log(message: string): void;
}

/** What server.js's default export returns. Both members are optional. */
export interface ExtensionServer {
  /** Events in order, delivered in batches (about every 250 ms). */
  onEvents?(events: readonly ExtensionEvent[]): void;
  handle?(req: ExtensionRequest): ExtensionResponse | Promise<ExtensionResponse>;
}

/** server.js: `export default (ctx) => ({ onEvents, handle })`. */
export type ExtensionServerFactory = (ctx: ExtensionContext) => ExtensionServer;

type Fc<P> = (props: Readonly<P>) => preact.JSX.Element;
type WithChildren = { children?: ComponentChildren };

/** WebUI building blocks, so an extension page looks like the rest of the app. */
export interface ExtensionUiKit {
  /** Intro line under the page title. */
  Lead: Fc<WithChildren>;
  ErrorText: Fc<WithChildren>;
  SectionLabel: Fc<WithChildren>;
  /** A panel of label/value rows (Row, EmptyRow). */
  List: Fc<WithChildren>;
  Row: Fc<{ label: string; value: string }>;
  EmptyRow: Fc<WithChildren>;
  /** A labelled control row. */
  Field: Fc<WithChildren & { label: string }>;
  /** Read by screen readers only. */
  VisuallyHidden: Fc<WithChildren>;
  StatusChip: Fc<{ variant: 'ok' | 'wait' | 'accent' | 'dim'; children: ComponentChildren }>;
  ChipRadioGroup: Fc<{
    name: string;
    label: string;
    value: string;
    options: ReadonlyArray<{ value: string; label: string }>;
    onChange: (value: string) => void;
  }>;
}

/** The host's own Preact: an extension must render with it, or hooks break. */
export interface ExtensionUiApi {
  readonly apiVersion: number;
  readonly preact: Pick<typeof import('preact'), 'h' | 'Fragment' | 'render'>;
  readonly hooks: Pick<
    typeof import('preact/hooks'),
    'useState' | 'useEffect' | 'useRef' | 'useMemo' | 'useCallback'
  >;
  readonly kit: ExtensionUiKit;
  /** GET /api/ext/<id>/<path>; rejects on a non-2xx reply. */
  getJson<T>(path: string, signal?: AbortSignal): Promise<T>;
  /** POST JSON to /api/ext/<id>/<path>; rejects with the server's `error` on failure. */
  postJson<T>(path: string, body?: unknown): Promise<T>;
  /** Hook: the live dock list, as the home screen shows it. */
  useDocks(): readonly DockStatus[];
}

/** ui.js: `export function mount(el, api) { …; return unmount; }`. */
export interface ExtensionUiModule {
  mount(el: HTMLElement, api: ExtensionUiApi): () => void;
}
