// An extension's page: the app draws the chrome (title, focus, Escape, Back) and the
// extension's ui.js mounts into the body (docs/extensions.md, ui.js).
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ExtensionUiModule } from '../../../extension/api.js';
import type { ExtensionInfo } from '../ui-types.js';
import { useDismiss } from '../lib/ui-hooks.js';
import { createExtensionApi } from './extension-kit.js';

export type ExtensionLoader = (id: string, version: string, rev: number) => Promise<unknown>;

/** version + rev in the URL: an update or a restart is imported afresh, not from cache. */
const importExtension: ExtensionLoader = (id, version, rev) => {
  const url = `/ext/${id}/ui.js?v=${encodeURIComponent(version)}&r=${rev}`;
  return import(url);
};

function isUiModule(mod: unknown): mod is ExtensionUiModule {
  return typeof (mod as Partial<ExtensionUiModule> | null)?.mount === 'function';
}

export function ExtensionPage({
  ext,
  onBack,
  load = importExtension,
}: Readonly<{
  ext: ExtensionInfo;
  onBack: () => void;
  load?: ExtensionLoader;
}>): preact.JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { id, version, rev } = ext;
  // Per load, so a reload (new rev) starts clean without a reset in the effect.
  const loadKey = `${id}@${version}#${rev}`;
  const [failedKey, setFailedKey] = useState<string | null>(null);

  useDismiss(onBack);
  useEffect(function focusHeading() {
    headingRef.current?.focus();
  }, []);
  useEffect(
    function mountExtension() {
      let unmount: (() => void) | undefined;
      let live = true;
      load(id, version, rev)
        .then((mod) => {
          if (!isUiModule(mod)) throw new Error('ui.js has no mount()');
          if (live && bodyRef.current) unmount = mod.mount(bodyRef.current, createExtensionApi(id));
          return undefined;
        })
        .catch(() => {
          if (live) setFailedKey(`${id}@${version}#${rev}`);
        });
      return function unmountExtension() {
        live = false;
        unmount?.();
      };
    },
    [id, version, rev, load],
  );

  return (
    <div class="help settings-page">
      <h1 ref={headingRef} tabIndex={-1}>
        {ext.page?.title ?? ext.name}
      </h1>
      {failedKey === loadKey && <p class="settings-error">Could not load {ext.name}.</p>}
      <div ref={bodyRef} />
    </div>
  );
}
