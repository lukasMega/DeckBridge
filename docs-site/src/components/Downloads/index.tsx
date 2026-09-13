import { useEffect, useState, type ReactNode } from 'react';

import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

import styles from './styles.module.css';

// Live release list for /getting-started. Fetched in the browser, not at build time: the
// docs deploy and the release workflow run independently, so a build-time snapshot would
// show the previous version until the next docs push.

const RELEASE_COUNT = 3;

type OsKey = 'macos' | 'windows' | 'linux';
type ArchKey = 'arm64' | 'x64';

const OS_LABEL: Record<OsKey, string> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
};

interface GhAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

interface GhRelease {
  tag_name: string;
  name: string | null;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
  assets: GhAsset[];
}

interface Asset {
  name: string;
  url: string;
  sizeMb: string;
  os: OsKey | null;
  arch: ArchKey | null;
  kind: string;
}

interface Release {
  tag: string;
  url: string;
  published: string | null;
  prerelease: boolean;
  assets: Asset[];
}

/** Asset names come from release.yml: `deckbridge-v1.2.3-macos-arm64.zip`, `DeckBridge_1.2.3_x64-setup.exe`, … */
function classify(name: string): { os: OsKey | null; arch: ArchKey | null; kind: string } {
  const n = name.toLowerCase();

  let os: OsKey | null = null;
  if (n.endsWith('.dmg') || n.includes('macos') || n.includes('darwin')) os = 'macos';
  else if (n.endsWith('.exe') || n.endsWith('.msi') || n.includes('windows')) os = 'windows';
  else if (n.includes('linux')) os = 'linux';

  let arch: ArchKey | null = null;
  if (/arm64|aarch64/.test(n)) arch = 'arm64';
  else if (/x86_64|x64|amd64/.test(n)) arch = 'x64';

  const kind = n.endsWith('.dmg')
    ? 'disk image'
    : n.endsWith('.exe') || n.endsWith('.msi')
      ? 'installer'
      : n.endsWith('.zip')
        ? 'portable zip'
        : 'file';

  return { os, arch, kind };
}

function archLabel(os: OsKey | null, arch: ArchKey | null): string {
  if (!arch) return '';
  if (os === 'macos') return arch === 'arm64' ? 'Apple silicon' : 'Intel';
  return arch === 'arm64' ? 'ARM64' : 'x86-64';
}

function toRelease(r: GhRelease): Release {
  return {
    tag: r.tag_name,
    url: r.html_url,
    published: r.published_at,
    prerelease: r.prerelease,
    assets: r.assets.map((a) => ({
      name: a.name,
      url: a.browser_download_url,
      sizeMb: `${(a.size / 1024 / 1024).toFixed(1)} MB`,
      ...classify(a.name),
    })),
  };
}

function detectOs(): OsKey | null {
  const ua = navigator.userAgent;
  if (/Mac|iPhone|iPad/.test(ua)) return 'macos';
  if (/Win/.test(ua)) return 'windows';
  if (/Linux|X11|CrOS/.test(ua)) return 'linux';
  return null;
}

/** macOS always reports "Intel", so arch only resolves where the UA (or the Chromium
 *  client-hint) carries it. `null` means "show every arch". */
function detectArchFromUa(): ArchKey | null {
  const ua = navigator.userAgent;
  if (/arm64|aarch64/i.test(ua)) return 'arm64';
  if (/x86_64|Win64|WOW64|x64/i.test(ua)) return 'x64';
  return null;
}

interface HighEntropyUa {
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
}

// One call per session, not per page view — the anonymous GitHub budget is 60/hour per IP.
// sessionStorage over localStorage so a new release shows up in the next tab; `:v1`
// retires the cache if `Release` changes shape.
const CACHE_PREFIX = 'deckbridge:releases:v1:';

function readCache(repo: string): Release[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + repo);
    return raw ? (JSON.parse(raw) as Release[]) : null;
  } catch {
    return null; // blocked (private mode) or bad JSON — refetch
  }
}

function writeCache(repo: string, releases: Release[]): void {
  try {
    sessionStorage.setItem(CACHE_PREFIX + repo, JSON.stringify(releases));
  } catch {
    // Blocked or over quota; the fetch already succeeded.
  }
}

export default function Downloads(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  const repo = `${siteConfig.organizationName}/${siteConfig.projectName}`;
  const releasesUrl = `https://github.com/${repo}/releases`;

  // All state starts empty so SSR and the first client render agree.
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [os, setOs] = useState<OsKey | null>(null);
  const [arch, setArch] = useState<ArchKey | null>(null);

  useEffect(() => {
    setOs(detectOs());
    setArch(detectArchFromUa());

    const uaData = (navigator as Navigator & { userAgentData?: HighEntropyUa }).userAgentData;
    void uaData?.getHighEntropyValues?.(['architecture']).then((v) => {
      if (v.architecture === 'arm') setArch('arm64');
      else if (v.architecture === 'x86') setArch('x64');
    });
  }, []);

  useEffect(() => {
    const cached = readCache(repo);
    if (cached) {
      setReleases(cached);
      return;
    }

    const ctl = new AbortController();

    fetch(`https://api.github.com/repos/${repo}/releases?per_page=10`, {
      signal: ctl.signal,
      headers: { Accept: 'application/vnd.github+json' },
    })
      .then((res) => (res.ok ? (res.json() as Promise<GhRelease[]>) : Promise.reject(res.status)))
      .then((all) => {
        const list = all
          .filter((r) => !r.draft)
          .slice(0, RELEASE_COUNT)
          .map(toRelease);
        writeCache(repo, list);
        setReleases(list);
      })
      .catch(() => {
        if (!ctl.signal.aborted) setFailed(true);
      });

    return () => ctl.abort();
  }, [repo]);

  if (failed) {
    return (
      <p className={styles.fallback}>
        Could not reach the GitHub API (rate limit or offline). Browse{' '}
        <a href={releasesUrl}>all releases</a> directly.
      </p>
    );
  }

  if (!releases) return <p className={styles.fallback}>Loading releases…</p>;
  if (releases.length === 0) {
    return (
      <p className={styles.fallback}>
        No published release yet — see <a href={releasesUrl}>the releases page</a>.
      </p>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.releaseRow} role="region" aria-label="Latest releases" tabIndex={0}>
        {releases.map((rel, i) => {
          // Arch filtering applies only when the arch is known AND published for this OS.
          // Guarded on `os`: otherwise an undetected OS matches what `classify()` could
          // not place (SHA256SUMS.txt, …) and recommends that.
          const forOs = os ? rel.assets.filter((a) => a.os === os) : [];
          const matched = arch ? forOs.filter((a) => a.arch === arch) : [];
          const primary = matched.length > 0 ? matched : forOs;
          const rest = rel.assets.filter((a) => !primary.includes(a));

          return (
            <section key={rel.tag} className={styles.release}>
              <h3 className={styles.head}>
                <a href={rel.url}>{rel.tag}</a>
                {i === 0 && <span className={styles.badge}>latest</span>}
                {rel.prerelease && <span className={styles.badge}>pre-release</span>}
                {rel.published && (
                  <time className={styles.date} dateTime={rel.published}>
                    {new Date(rel.published).toISOString().slice(0, 10)}
                  </time>
                )}
              </h3>

              {os && primary.length > 0 ? (
                <>
                  <p className={styles.osLine}>
                    Detected: <b>{OS_LABEL[os]}</b>
                    {arch && matched.length > 0 ? ` · ${archLabel(os, arch)}` : ''}
                  </p>
                  <AssetList assets={primary} />
                </>
              ) : (
                <p className={styles.osLine}>
                  {os
                    ? `No ${OS_LABEL[os]} build in this release.`
                    : 'Could not detect your OS — pick a build below.'}
                </p>
              )}

              {rest.length > 0 && (
                <details className={styles.more}>
                  <summary>Other platforms ({rest.length})</summary>
                  <AssetList assets={rest} showOs />
                </details>
              )}
            </section>
          );
        })}
      </div>

      <p className={styles.fallback}>
        <a href={releasesUrl}>All releases and changelogs on GitHub →</a>
      </p>
    </div>
  );
}

function AssetList({ assets, showOs }: { assets: Asset[]; showOs?: boolean }): ReactNode {
  return (
    <ul className={styles.assets}>
      {assets.map((a) => (
        <li key={a.name}>
          <a href={a.url}>{a.name}</a>
          <span className={styles.meta}>
            {[showOs && a.os ? OS_LABEL[a.os] : '', archLabel(a.os, a.arch), a.kind, a.sizeMb]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </li>
      ))}
    </ul>
  );
}
