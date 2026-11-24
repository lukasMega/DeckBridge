// Home-screen "new version" banner (see update-check.ts). Install runs only under
// the Tauri shell; portable/Linux builds link the zip instead.
import { useState } from 'preact/hooks';
import { ICON, Icon } from '../components/Icon.js';
import { fire, postJson } from '../lib/ui-api.js';
import { useStore } from '../lib/store.js';
import { updateBadgeVersion } from '../ui-helpers.js';
import type { UpdateInfo } from '../ui-types.js';

export const INSTALLING_TEXT = 'Installing… DeckBridge restarts in a moment.';

/** POST /api/update/install; the relay exits right after the reply. */
export function installUpdate(): Promise<void> {
  return postJson('/api/update/install', undefined, 'Install failed');
}

/** Install button or download link for `info`, or null when neither applies. */
export function UpdateAction({
  info,
  onInstall,
}: Readonly<{ info: UpdateInfo; onInstall: () => void }>): preact.JSX.Element | null {
  if (info.canInstall)
    return (
      <button class="linkbtn accent" type="button" onClick={onInstall}>
        Install v{info.latest}
      </button>
    );
  if (!info.downloadUrl) return null;
  return (
    <a class="linkbtn accent" href={info.downloadUrl} target="_blank" rel="noopener">
      Download v{info.latest}
    </a>
  );
}

export function UpdateBanner(): preact.JSX.Element | null {
  const info = useStore((s) => s.updateInfo);
  const [status, setStatus] = useState<string | null>(null);
  const version = updateBadgeVersion(info);
  // After the restart the new version reports no update, which hides a stale "Installing…".
  if (!info || !version) return null;

  const install = (): void => {
    setStatus(INSTALLING_TEXT);
    installUpdate().catch((e: unknown) =>
      setStatus(e instanceof Error ? e.message : 'Install failed'),
    );
  };

  return (
    <div class="warnrow conn-banner" id="updateBanner" role="status">
      <span>{status ?? `DeckBridge v${version} is available.`}</span>
      {!status && (
        <>
          <UpdateAction info={info} onInstall={install} />
          <a class="linkbtn" href={info.releaseUrl} target="_blank" rel="noopener">
            Release notes
          </a>
          <button
            class="iconbtn circle"
            type="button"
            aria-label="Hide update notice"
            title="Hide update notice"
            onClick={() => fire('/api/update/dismiss', { version })}
          >
            <Icon html={ICON.close} />
          </button>
        </>
      )}
    </div>
  );
}
