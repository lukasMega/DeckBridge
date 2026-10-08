// Reusable stage controls: copy chip, manual-add panel,
// and the brightness fader. (Live key-grid preview moved to
// components/KeyGridPreview.tsx — shared with the advanced view.)
import { useState, useEffect, useRef } from 'preact/hooks';
import { useStore } from '../lib/store.js';
import { useCopyText } from '../lib/use-copy-text.js';
import { ICON, Icon, HelpButton } from '../components/Icon.js';
import { CORA_PORT } from '../ui-help.js';
import { fire } from '../lib/ui-api.js';
import { postBrightnessOverride } from './handlers.js';
import { GhostButton } from '../components/GhostButton.js';

/** "Back" pill used by the settings and help screens. */
export function BackButton({ onClick }: Readonly<{ onClick: () => void }>): preact.JSX.Element {
  return (
    <GhostButton class="help-back" onClick={onClick}>
      <Icon html={ICON.back} />
      <span>Back</span>
    </GhostButton>
  );
}

export function CopyChip({
  label,
  value,
  cls,
  pending,
}: Readonly<{
  label: string;
  value: string;
  cls: string;
  pending?: boolean;
}>): preact.JSX.Element {
  const { status, copy } = useCopyText();
  const handleClick = (): void => {
    if (!pending) void copy(value);
  };

  if (status === 'copied') {
    return (
      <button class={`${cls} copied`} type="button" onClick={handleClick}>
        <span class="addr-text">Copied</span>
        <Icon class="addr-copy" html={ICON.check} />
      </button>
    );
  }

  return (
    <button
      class={cls}
      type="button"
      disabled={pending}
      aria-label={pending ? 'Detecting IP…' : `Copy ${label} ${value}`}
      title={status === 'error' ? 'Copy failed. Select and copy the value manually.' : undefined}
      onClick={handleClick}
    >
      <span class="addr-label" aria-live="polite">
        {status === 'error' ? 'Copy failed' : label}
      </span>
      <span class="addr-text">{pending ? '…' : value}</span>
      <Icon class="addr-copy" html={ICON.copy} />
    </button>
  );
}

export function ManualAddPanel({
  onHelp,
  port = CORA_PORT,
  expanded = false,
}: Readonly<{
  onHelp: (id: string) => void;
  port?: string;
  expanded?: boolean;
}>): preact.JSX.Element {
  const ip = useStore((s) => s.status.localIp);

  return (
    <details class="manual-add panel-inset" open={expanded}>
      <summary class="manual-add-head">Pair manually</summary>
      <p class="step-sub">
        In the Elgato app, open the device menu (top left), choose{' '}
        <strong>Add Network Device…</strong> and enter:{' '}
        <HelpButton
          helpId="network-device"
          onHelp={onHelp}
          ariaLabel="Help: add a network device"
          title="Show me how"
        />
      </p>
      <div class="addr-row">
        <CopyChip label="IP" value={ip} cls="addr-chip" pending={!ip} />
      </div>
      <details class="addr-other">
        <summary class="step-sub">Elgato app on this computer?</summary>
        <div class="addr-row">
          <CopyChip label="IP" value="127.0.0.1" cls="addr-port-chip" />
          <CopyChip label="Port" value={port} cls="addr-port-chip" />
        </div>
      </details>
    </details>
  );
}

let _brightnessDebounce: ReturnType<typeof setTimeout> | null = null;

export function Brightness({
  dock = 0,
  level,
  compact = false,
}: Readonly<{
  /** Dock index the slider drives (0 = primary). */
  dock?: number;
  /** Dock-specific level (multi-device); falls back to the store's primary value. */
  level?: number;
  /** Shown in the label when set (multi-device: the selected dock's model). */
  deviceName?: string;
  /** Compact row for the live preview footer. */
  compact?: boolean;
}> = {}): preact.JSX.Element {
  const storeBrightness = useStore((s) => s.brightness);
  const brightnessOverride = useStore((s) => s.brightnessOverride);
  const brightness = level ?? storeBrightness;

  // Local slider value so the UI feels snappy while debouncing
  const [localVal, setLocalVal] = useState(brightness);
  const draggingRef = useRef(false);

  // Sync from store when not dragging
  useEffect(() => {
    if (!draggingRef.current) setLocalVal(brightness);
  }, [brightness]);

  const handleInput = (e: Event): void => {
    const v = parseInt((e.target as HTMLInputElement).value, 10);
    setLocalVal(v);
    if (_brightnessDebounce !== null) clearTimeout(_brightnessDebounce);
    _brightnessDebounce = setTimeout(() => fire('/api/brightness', { level: v, dock }), 100);
  };

  const handleMouseDown = (): void => {
    draggingRef.current = true;
  };
  const handleTouchStart = (): void => {
    draggingRef.current = true;
  };
  const handleChange = (): void => {
    draggingRef.current = false;
  };

  const sourceSelect = (
    <select
      class="b-mode-select"
      value={brightnessOverride ? 'ignore' : 'control'}
      aria-label="Brightness source"
      onChange={postBrightnessOverride}
    >
      <option value="ignore">{compact ? 'Manual' : '🔆 Manual'}</option>
      <option value="control">{compact ? 'Elgato app' : '🔗 Elgato app'}</option>
    </select>
  );

  return (
    <div>
      <div class={compact ? 'brightness brightness-footer' : 'brightness'}>
        {!compact && sourceSelect}
        <Icon class="b-ico" html={ICON.sun} />
        <div class="fader">
          <input
            type="range"
            class="range"
            disabled={!brightnessOverride}
            id="simple-brightness"
            min="0"
            max="100"
            value={localVal}
            aria-label="Screen brightness"
            style={`--fill:${localVal}%`}
            onMouseDown={handleMouseDown}
            onTouchStart={handleTouchStart}
            onChange={handleChange}
            onInput={handleInput}
          />
        </div>
        <span class="b-val" id="simple-brightness-val">
          {localVal}%
        </span>
        {compact && sourceSelect}
      </div>
    </div>
  );
}
