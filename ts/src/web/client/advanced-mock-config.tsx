/**
 * MockConfigForm — collapsible device config panel.
 *
 * Split out of AdvancedApp.tsx (file-size refactor, no behavior change).
 *
 * The six fields are identical apart from their id/label/limits/presets, so they
 * are table-driven off CFG_FIELDS: one state record, one sync effect (instead of
 * six, each needing its own set-state-in-effect suppression), one field renderer.
 */
import { Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { useStore } from './store.js';
import { fire } from './ui-api.js';
import { Collapsible } from './components/Collapsible.js';

const MAC_DEFAULT = '02:00:00:00:00:01';

/** Hex text ⇄ numeric productId; every other field is a plain string. */
const pidToText = (pid: number | undefined): string =>
  `0x${(pid ?? 0).toString(16).padStart(4, '0')}`;

type FieldKey = 'dockFw' | 'dockSerial' | 'childFw' | 'childSerial' | 'childPid' | 'mac';

interface CfgField {
  key: FieldKey;
  id: string;
  label: string;
  maxLength: number;
  placeholder: string;
  /** Quick-fill buttons. `label` defaults to the value itself. */
  presets: readonly { value: string; label?: string }[];
  /** Group heading rendered above this field, if it starts a group. */
  group?: 'dock' | 'child';
}

const CFG_FIELDS: readonly CfgField[] = [
  {
    key: 'dockFw',
    id: 'cfg-dock-fw',
    label: 'Dock FW',
    maxLength: 8,
    placeholder: '1.01.014',
    presets: [{ value: '1.01.014' }],
    group: 'dock',
  },
  {
    key: 'dockSerial',
    id: 'cfg-dock-serial',
    label: 'Dock Serial',
    maxLength: 20,
    placeholder: 'CL21K1A00001',
    presets: [{ value: 'CL21K1A00001' }],
  },
  {
    key: 'childFw',
    id: 'cfg-child-fw',
    label: 'Child FW',
    maxLength: 8,
    placeholder: '1.03.000',
    presets: [{ value: '1.03.000' }, { value: '2.00.026' }],
    group: 'child',
  },
  {
    key: 'childSerial',
    id: 'cfg-child-serial',
    label: 'Child Serial',
    maxLength: 20,
    placeholder: 'A7FZA5191ILSNQ',
    presets: [{ value: 'A7FZA5191ILSNQ' }, { value: 'CL21K1A00001' }],
  },
  {
    key: 'childPid',
    id: 'cfg-child-pid',
    label: 'Child PID (hex)',
    maxLength: 6,
    placeholder: '0x00a5',
    presets: [{ value: '0x00a5' }, { value: '0x0080' }],
  },
  {
    key: 'mac',
    id: 'cfg-mac',
    label: 'Dock MAC',
    maxLength: 17,
    placeholder: MAC_DEFAULT,
    presets: [{ value: MAC_DEFAULT, label: 'default' }],
  },
];

type FieldValues = Record<FieldKey, string>;

export function MockConfigForm(): preact.JSX.Element {
  const mockConfig = useStore((s) => s.mockConfig);
  const status = useStore((s) => s.status);

  const [values, setValues] = useState<FieldValues>(() => ({
    dockFw: mockConfig?.dockFirmwareVersion ?? '',
    dockSerial: mockConfig?.serialNumber ?? '',
    childFw: mockConfig?.childFirmwareVersion ?? '',
    childSerial: mockConfig?.childSerialNumber ?? '',
    childPid: pidToText(mockConfig?.productId),
    mac: mockConfig?.macAddress ?? MAC_DEFAULT,
  }));

  // Sync from store when mockConfig arrives / changes
  useEffect(() => {
    if (!mockConfig) return;
    // eslint-disable-next-line @eslint-react/set-state-in-effect -- controlled form fields must sync from external store; no other pattern applies here
    setValues({
      dockFw: mockConfig.dockFirmwareVersion ?? '',
      dockSerial: mockConfig.serialNumber ?? '',
      childFw: mockConfig.childFirmwareVersion ?? '',
      childSerial: mockConfig.childSerialNumber ?? '',
      childPid: pidToText(mockConfig.productId),
      mac: mockConfig.macAddress ?? MAC_DEFAULT,
    });
  }, [mockConfig]);

  const set = (key: FieldKey, value: string): void =>
    setValues((prev) => ({ ...prev, [key]: value }));

  function handleApply(): void {
    const pid = parseInt(values.childPid, 16);
    fire('/api/mock-config', {
      dockFirmwareVersion: values.dockFw,
      childFirmwareVersion: values.childFw,
      serialNumber: values.dockSerial,
      childSerialNumber: values.childSerial,
      productId: isNaN(pid) ? (mockConfig?.productId ?? 0) : pid,
      macAddress: values.mac.trim(),
    });
  }

  return (
    <Collapsible
      class="panel"
      id="mock-cfg-panel"
      bodyId="mock-cfg-body"
      title="Device Config"
      subtitle="(all modes)"
    >
      <div class="cfg-grid">
        {CFG_FIELDS.map((f) => (
          <Fragment key={f.id}>
            {f.group === 'dock' && <strong>Dock (Network Dock)</strong>}
            {f.group === 'child' && (
              <strong>
                Child (
                <span id="cfg-child-model-label">{status.modelName ?? 'Stream Deck MK.2'}</span>)
              </strong>
            )}
            <label>{f.label}</label>
            <span class="cfg-inp-group">
              <input
                id={f.id}
                type="text"
                class="input"
                maxLength={f.maxLength}
                placeholder={f.placeholder}
                value={values[f.key]}
                onInput={(e) => set(f.key, (e.target as HTMLInputElement).value)}
              />
              {f.presets.map((p) => (
                <button
                  key={p.value}
                  class="ghostbtn cfg-preset"
                  type="button"
                  onClick={() => set(f.key, p.value)}
                >
                  {p.label ?? p.value}
                </button>
              ))}
            </span>
          </Fragment>
        ))}
      </div>
      <button id="cfg-apply" class="ghostbtn" type="button" onClick={handleApply}>
        Apply
      </button>
    </Collapsible>
  );
}
