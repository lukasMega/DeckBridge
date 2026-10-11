// Finds extension folders and checks their manifest.json (docs/extensions.md#manifest).
import { EXTENSION_API_VERSION } from '../../extension/api.js';
import type { ExtensionManifest } from '../../extension/api.js';
import { EXTENSION_ID } from '../../infra/settings-sanitize.js';

/** One folder under the extensions dir; `problem` set = it can never run. */
export interface FoundExtension {
  id: string;
  dir: string;
  manifest?: ExtensionManifest;
  problem?: string;
}

const MAX_TEXT = 280;
const MAX_ICON = 4096;

const text = (v: unknown, max = 64): v is string =>
  typeof v === 'string' && v.trim() !== '' && v.length <= max;

type Checked<T> = { value: T } | { problem: string };

function checkPage(page: unknown): Checked<ExtensionManifest['page']> {
  if (page === undefined) return { value: undefined };
  const p = page as Record<string, unknown> | null;
  if (typeof p !== 'object' || p === null || !text(p.title, 32)) {
    return { problem: 'page.title is required' };
  }
  if (p.icon === undefined) return { value: { title: p.title } };
  if (typeof p.icon !== 'string' || !p.icon.startsWith('<svg') || p.icon.length > MAX_ICON) {
    return { problem: 'page.icon must be inline <svg> markup' };
  }
  return { value: { title: p.title, icon: p.icon } };
}

/** The manifest, or why it is rejected. */
export function checkManifest(
  raw: unknown,
  folder: string,
): { manifest: ExtensionManifest } | { problem: string } {
  const m = raw as Record<string, unknown> | null;
  if (typeof m !== 'object' || m === null) return { problem: 'manifest.json is not an object' };
  if (m.id !== folder) return { problem: `manifest id must equal the folder name "${folder}"` };
  if (!text(m.name) || !text(m.version, 32)) return { problem: 'name and version are required' };
  if (m.apiVersion !== EXTENSION_API_VERSION) {
    return {
      problem: `needs extension API ${String(m.apiVersion)}; this DeckBridge has ${EXTENSION_API_VERSION}`,
    };
  }
  const { description } = m;
  if (description !== undefined && !text(description, MAX_TEXT)) {
    return { problem: `description must be text up to ${MAX_TEXT} characters` };
  }
  const page = checkPage(m.page);
  if ('problem' in page) return page;
  const manifest: ExtensionManifest = {
    id: folder,
    name: m.name,
    version: m.version,
    apiVersion: EXTENSION_API_VERSION,
    ...(description === undefined ? {} : { description }),
    ...(page.value ? { page: page.value } : {}),
  };
  return { manifest };
}

async function readFolder(id: string, dir: string): Promise<FoundExtension> {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(await tjs.readFile(`${dir}/manifest.json`)));
  } catch (e) {
    return { id, dir, problem: `manifest.json unreadable: ${(e as Error).message}` };
  }
  const checked = checkManifest(raw, id);
  if ('problem' in checked) return { id, dir, problem: checked.problem };
  try {
    if (!(await tjs.stat(`${dir}/server.js`)).isFile) throw new Error('not a file');
  } catch {
    return { id, dir, manifest: checked.manifest, problem: 'server.js is missing' };
  }
  return { id, dir, manifest: checked.manifest };
}

/** Every folder with an addressable id, sorted. A missing dir is empty; any other read
 *  error throws. */
export async function scanExtensions(root: string): Promise<Map<string, FoundExtension>> {
  const ids: string[] = [];
  try {
    for await (const e of await tjs.readDir(root)) {
      // Not only directories: a symlinked folder (allowed) reports neither file nor directory.
      if (!e.isFile && EXTENSION_ID.test(e.name)) ids.push(e.name);
    }
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return new Map();
    throw e;
  }
  const found = await Promise.all(
    ids.toSorted((a, b) => a.localeCompare(b)).map((id) => readFolder(id, `${root}/${id}`)),
  );
  return new Map(found.map((f) => [f.id, f]));
}
