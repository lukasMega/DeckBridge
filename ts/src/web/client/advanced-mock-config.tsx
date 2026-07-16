/**
 * MockConfigForm — collapsible device config panel.
 *
 * Split out of AdvancedApp.tsx (file-size refactor, no behavior change).
 */
import { useState, useEffect } from 'preact/hooks';
import { useStore } from './store.js';

// ---------------------------------------------------------------------------
// MockConfigForm — collapsible device config panel
// ---------------------------------------------------------------------------

export function MockConfigForm(): preact.JSX.Element {
  const mockConfig = useStore((s) => s.mockConfig);
  const status = useStore((s) => s.status);

  const [dockFw, setDockFw] = useState(mockConfig?.dockFirmwareVersion ?? '');
  const [dockSerial, setDockSerial] = useState(mockConfig?.serialNumber ?? '');
  const [childFw, setChildFw] = useState(mockConfig?.childFirmwareVersion ?? '');
  const [childSerial, setChildSerial] = useState(mockConfig?.childSerialNumber ?? '');
  const [childPid, setChildPid] = useState(
    () => `0x${(mockConfig?.productId ?? 0).toString(16).padStart(4, '0')}`,
  );
  const [mac, setMac] = useState(mockConfig?.macAddress ?? '02:00:00:00:00:01');
  const [open, setOpen] = useState(false);

  // Sync from store when mockConfig arrives / changes
  useEffect(() => {
    if (!mockConfig) return;
    // eslint-disable-next-line @eslint-react/set-state-in-effect -- controlled form fields must sync from external store; no other pattern applies here
    setDockFw(mockConfig.dockFirmwareVersion ?? '');
    // eslint-disable-next-line @eslint-react/set-state-in-effect
    setDockSerial(mockConfig.serialNumber ?? '');
    // eslint-disable-next-line @eslint-react/set-state-in-effect
    setChildFw(mockConfig.childFirmwareVersion ?? '');
    // eslint-disable-next-line @eslint-react/set-state-in-effect
    setChildSerial(mockConfig.childSerialNumber ?? '');
    // eslint-disable-next-line @eslint-react/set-state-in-effect
    setChildPid(`0x${(mockConfig.productId ?? 0).toString(16).padStart(4, '0')}`);
    // eslint-disable-next-line @eslint-react/set-state-in-effect
    setMac(mockConfig.macAddress ?? '02:00:00:00:00:01');
  }, [mockConfig]);

  function handleApply(): void {
    const pid = parseInt(childPid, 16);
    void fetch('/api/mock-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dockFirmwareVersion: dockFw,
        childFirmwareVersion: childFw,
        serialNumber: dockSerial,
        childSerialNumber: childSerial,
        productId: isNaN(pid) ? (mockConfig?.productId ?? 0) : pid,
        macAddress: mac.trim(),
      }),
    });
  }

  return (
    <div class="panel collapsible" id="mock-cfg-panel">
      <h3 class={`collapse-header${open ? '' : ' collapsed'}`} onClick={() => setOpen((o) => !o)}>
        <span>
          Device Config <span class="cfg-subtitle-hdr">(all modes)</span>
        </span>
        <span class="collapse-arrow">▼</span>
      </h3>
      <div id="mock-cfg-body" class={`collapse-body${open ? ' open' : ''}`}>
        <div class="cfg-grid">
          <strong>Dock (Network Dock)</strong>
          <label>Dock FW</label>
          <span class="cfg-inp-group">
            <input
              id="cfg-dock-fw"
              type="text"
              maxLength={8}
              placeholder="1.01.014"
              value={dockFw}
              onInput={(e) => setDockFw((e.target as HTMLInputElement).value)}
            />
            <button class="cfg-preset" type="button" onClick={() => setDockFw('1.01.014')}>
              1.01.014
            </button>
          </span>
          <label>Dock Serial</label>
          <span class="cfg-inp-group">
            <input
              id="cfg-dock-serial"
              type="text"
              maxLength={20}
              placeholder="CL21K1A00001"
              value={dockSerial}
              onInput={(e) => setDockSerial((e.target as HTMLInputElement).value)}
            />
            <button class="cfg-preset" type="button" onClick={() => setDockSerial('CL21K1A00001')}>
              CL21K1A00001
            </button>
          </span>
          <strong>
            Child (<span id="cfg-child-model-label">{status.modelName ?? 'Stream Deck MK.2'}</span>)
          </strong>
          <label>Child FW</label>
          <span class="cfg-inp-group">
            <input
              id="cfg-child-fw"
              type="text"
              maxLength={8}
              placeholder="1.03.000"
              value={childFw}
              onInput={(e) => setChildFw((e.target as HTMLInputElement).value)}
            />
            <button class="cfg-preset" type="button" onClick={() => setChildFw('1.03.000')}>
              1.03.000
            </button>
            <button class="cfg-preset" type="button" onClick={() => setChildFw('2.00.026')}>
              2.00.026
            </button>
          </span>
          <label>Child Serial</label>
          <span class="cfg-inp-group">
            <input
              id="cfg-child-serial"
              type="text"
              maxLength={20}
              placeholder="A7FZA5191ILSNQ"
              value={childSerial}
              onInput={(e) => setChildSerial((e.target as HTMLInputElement).value)}
            />
            <button
              class="cfg-preset"
              type="button"
              onClick={() => setChildSerial('A7FZA5191ILSNQ')}
            >
              A7FZA5191ILSNQ
            </button>
            <button class="cfg-preset" type="button" onClick={() => setChildSerial('CL21K1A00001')}>
              CL21K1A00001
            </button>
          </span>
          <label>Child PID (hex)</label>
          <span class="cfg-inp-group">
            <input
              id="cfg-child-pid"
              type="text"
              maxLength={6}
              placeholder="0x00a5"
              value={childPid}
              onInput={(e) => setChildPid((e.target as HTMLInputElement).value)}
            />
            <button class="cfg-preset" type="button" onClick={() => setChildPid('0x00a5')}>
              0x00a5
            </button>
            <button class="cfg-preset" type="button" onClick={() => setChildPid('0x0080')}>
              0x0080
            </button>
          </span>
          <label>Dock MAC</label>
          <span class="cfg-inp-group">
            <input
              id="cfg-mac"
              type="text"
              maxLength={17}
              placeholder="02:00:00:00:00:01"
              value={mac}
              onInput={(e) => setMac((e.target as HTMLInputElement).value)}
            />
            <button class="cfg-preset" type="button" onClick={() => setMac('02:00:00:00:00:01')}>
              default
            </button>
          </span>
        </div>
        <button id="cfg-apply" type="button" onClick={handleApply}>
          Apply
        </button>
      </div>
    </div>
  );
}
