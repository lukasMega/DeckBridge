// QR code for the pairing URL (plan D12). No QR library ships with DeckBridge: after an explicit
// confirm, one pinned file is fetched from a CDN and run ONLY inside a sandboxed iframe (no
// allow-same-origin), because the admin page can edit settings and bind keys to shell commands.
// The frame gets text and returns a boolean matrix; nothing else crosses the boundary.
import { useEffect, useState } from 'preact/hooks';

export const QR_LIB = {
  name: 'qrcode-generator',
  version: '1.4.4',
  license: 'MIT',
  sizeKb: 55,
  url: 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js',
  // Hash of package/qrcode.js in the npm tarball (verified against it, not only the CDN copy).
  integrity: 'sha384-8FWZA6BGMXhsfO+BLtrJK0We6gg5o1JyO8xQm6peWDEUs17ACA5ziE/NIAkl9z2k',
} as const;

const QUIET_ZONE = 4;
const MAX_MODULES = 100;
const LOAD_TIMEOUT_MS = 15_000;

/** The result must be a square boolean matrix of a plausible size, or it is thrown away. */
export function validateMatrix(v: unknown): boolean[][] | null {
  if (!Array.isArray(v) || v.length < 21 || v.length > MAX_MODULES) return null;
  const n = v.length;
  const out: boolean[][] = [];
  for (const row of v) {
    if (!Array.isArray(row) || row.length !== n) return null;
    const cells: boolean[] = [];
    for (const cell of row) {
      if (typeof cell !== 'boolean') return null;
      cells.push(cell);
    }
    out.push(cells);
  }
  return out;
}

/** SVG path for the dark modules, inside a quiet zone. */
export function matrixPath(matrix: boolean[][]): { d: string; size: number } {
  let d = '';
  for (let y = 0; y < matrix.length; y++) {
    const row = matrix[y]!;
    for (let x = 0; x < row.length; x++) {
      if (row[x]) d += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
    }
  }
  return { d, size: matrix.length + QUIET_ZONE * 2 };
}

export type QrLoader = (text: string) => Promise<boolean[][]>;

// Runs inside the sandbox: loads the pinned file (SRI-checked by the browser), then answers one
// `make` message with the matrix. Values are quoted via JSON so the markup cannot be broken.
const QR_CSP = `default-src 'none'; script-src 'unsafe-inline' ${new URL(QR_LIB.url).origin}; connect-src 'none'; img-src 'none'; form-action 'none'; base-uri 'none'`;

function sandboxDoc(): string {
  const src = JSON.stringify(QR_LIB.url);
  const integrity = JSON.stringify(QR_LIB.integrity);
  return (
    '<!doctype html><meta charset="utf-8">' +
    // Nothing may leave the frame except postMessage: the pairing URL is sent in here.
    `<meta http-equiv="Content-Security-Policy" content="${QR_CSP}"><script>` +
    `var s=document.createElement('script');s.src=${src};s.integrity=${integrity};` +
    "s.crossOrigin='anonymous';" +
    "s.onerror=function(){parent.postMessage({t:'error'},'*')};" +
    "s.onload=function(){parent.postMessage({t:'ready'},'*')};" +
    'document.head.appendChild(s);' +
    "addEventListener('message',function(e){if(!e.data||e.data.t!=='make')return;" +
    "try{var q=qrcode(0,'M');q.addData(String(e.data.text));q.make();var n=q.getModuleCount(),m=[];" +
    'for(var r=0;r<n;r++){var row=[];for(var c=0;c<n;c++)row.push(q.isDark(r,c)===true);m.push(row)}' +
    "parent.postMessage({t:'matrix',matrix:m},'*')}catch(x){parent.postMessage({t:'error'},'*')}});" +
    '</script>'
  );
}

export function loadQrViaSandbox(text: string): Promise<boolean[][]> {
  return new Promise<boolean[][]>((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts'); // deliberately no allow-same-origin
    frame.style.display = 'none';
    const finish = (err: Error | null, matrix?: boolean[][]): void => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      frame.remove();
      if (matrix) resolve(matrix);
      else reject(err ?? new Error('QR failed'));
    };
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== frame.contentWindow) return; // not ours
      const data = e.data as { t?: string; matrix?: unknown } | null;
      // A sandboxed frame has an opaque origin, so '*' is the only possible target.
      // eslint-disable-next-line sonarjs/post-message
      if (data?.t === 'ready') frame.contentWindow?.postMessage({ t: 'make', text }, '*');
      else if (data?.t === 'matrix') {
        const matrix = validateMatrix(data.matrix);
        finish(
          matrix ? null : new Error('QR library returned an invalid result'),
          matrix ?? undefined,
        );
      } else if (data?.t === 'error') finish(new Error('Could not load the QR library'));
    };
    const timer = setTimeout(() => finish(new Error('QR library timed out')), LOAD_TIMEOUT_MS);
    window.addEventListener('message', onMessage);
    frame.srcdoc = sandboxDoc();
    document.body.appendChild(frame);
  });
}

// Consent lasts for this page load only: a reload asks again.
let consented = false;

type QrState =
  | { kind: 'ask' }
  | { kind: 'loading' }
  | { kind: 'ready'; text: string; matrix: boolean[][] }
  | { kind: 'failed'; message: string };

export function PairingQr({
  text,
  load = loadQrViaSandbox,
}: Readonly<{ text: string; load?: QrLoader }>): preact.JSX.Element {
  const [state, setState] = useState<QrState>({ kind: consented ? 'loading' : 'ask' });

  async function run(): Promise<void> {
    setState({ kind: 'loading' });
    try {
      setState({ kind: 'ready', text, matrix: await load(text) });
    } catch (e) {
      setState({ kind: 'failed', message: (e as Error).message });
    }
  }

  function confirm(): void {
    consented = true;
    void run();
  }

  // A later pairing in the same page load needs no second prompt.
  useEffect(
    function autoLoad() {
      if (consented) void run();
    },
    // `run` is re-created per render; the QR depends only on the text.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
    [text],
  );

  if (state.kind === 'ask' || state.kind === 'failed') {
    return (
      <div class="panel-inset pairing-qr-consent" id="qr-consent">
        {state.kind === 'failed' && <p class="settings-error">{state.message}</p>}
        <p>
          Show a QR code? DeckBridge ships no QR library. This downloads{' '}
          <b>
            {QR_LIB.name} {QR_LIB.version}
          </b>{' '}
          ({QR_LIB.license}, about {QR_LIB.sizeKb} kB) from the jsDelivr CDN:
        </p>
        <code class="push-token">{QR_LIB.url}</code>
        <p class="multi-deck-note">
          The request leaves this computer. The file is checked against {QR_LIB.integrity} and runs
          in an isolated frame that cannot reach DeckBridge. Skip this and use the 6-digit code
          instead.
        </p>
        <button class="ghostbtn" id="qr-load" type="button" onClick={confirm}>
          {state.kind === 'failed' ? 'Try again' : 'Load QR code'}
        </button>
      </div>
    );
  }
  if (state.kind === 'loading') return <p class="multi-deck-note">Loading QR code…</p>;
  const { d, size } = matrixPath(state.matrix);
  return (
    <svg
      class="pairing-qr"
      role="img"
      aria-label="Pairing QR code"
      viewBox={`0 0 ${size} ${size}`}
      width="200"
      height="200"
      shape-rendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
