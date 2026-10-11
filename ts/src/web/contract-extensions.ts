// Extensions wire DTOs: GET /api/extensions, /api/state `extensions` and the WS `extensions` event.

/** 'invalid' = a folder with a bad or incompatible manifest.json; it can never run. */
export type ExtensionState = 'disabled' | 'loading' | 'running' | 'error' | 'invalid';

export interface ExtensionInfo {
  /** The folder name; for 'invalid' entries also the only trusted field. */
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled: boolean;
  state: ExtensionState;
  /** Why it is 'error' or 'invalid'. */
  error?: string;
  page?: { title: string; icon?: string };
  /** Bumped on every worker start, so the browser re-imports ui.js after a reload. */
  rev: number;
}

export interface ExtensionsView {
  /** Where extension folders are looked up (Settings shows it). */
  dir: string;
  extensions: ExtensionInfo[];
}
