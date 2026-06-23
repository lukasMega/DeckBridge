// Reusable stage controls: checklist step, copy chip, manual-add panel,
// live key-grid preview, and the brightness fader.
import { useState, useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { useStore } from '../store.js';
import { ICON } from '../ui-icons.js';
import { CORA_PORT } from '../ui-state.js';
import { KeyPreview } from '../key-preview.js';
import { Icon, HelpButton } from './Icon.js';
import { openSdApp, postBrightnessOverride } from './handlers.js';

type StepKind = 'done' | 'active' | 'pending';

export function Step({
  kind,
  title,
  helpId,
  onHelp,
  children,
}: Readonly<{
  kind: StepKind;
  title: string;
  helpId?: string;
  onHelp?: (id: string) => void;
  children?: ComponentChildren;
}>): preact.JSX.Element {
  return (
    <div class={`step ${kind}`}>
      <div class="step-ico">
        {kind === 'done' && <Icon class="ico-done" html={ICON.check} />}
        {kind === 'active' && <span class="ico-spin" />}
        {kind === 'pending' && <span class="ico-pending" />}
      </div>
      <div class="step-body">
        <div class="step-title">
          <span>{title}</span>
          {helpId !== undefined && onHelp !== undefined && (
            <HelpButton
              helpId={helpId}
              onHelp={onHelp}
              ariaLabel={`Help: ${title}`}
              title="What do I do here?"
            />
          )}
        </div>
        {children}
      </div>
    </div>
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
  const [copied, setCopied] = useState(false);
  const tidRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClick = (): void => {
    if (pending) return;
    const done = (): void => {
      setCopied(true);
      if (tidRef.current !== null) clearTimeout(tidRef.current);
      tidRef.current = setTimeout(() => setCopied(false), 1500);
    };
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- clipboard absent in insecure contexts
    if (navigator.clipboard.writeText) {
      void navigator.clipboard.writeText(value).finally(() => done());
    } else {
      done();
    }
  };

  if (copied) {
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
      onClick={handleClick}
    >
      <span class="addr-label">{label}</span>
      <span class="addr-text">{pending ? '…' : value}</span>
      <Icon class="addr-copy" html={ICON.copy} />
    </button>
  );
}

export function ManualAddPanel({
  onHelp,
}: Readonly<{ onHelp: (id: string) => void }>): preact.JSX.Element {
  const ip = useStore((s) => s.status.localIp ?? '');
  const pending = !ip;

  return (
    <div class="manual-add">
      <div
        class="manual-add-head"
        style="display:flex;align-items:center;justify-content:space-between;gap:8px;"
      >
        <span>Not showing up?</span>
        <HelpButton
          helpId="network-device"
          onHelp={onHelp}
          ariaLabel="Help: add a network device"
          title="Show me how"
        />
      </div>
      <div class="manual-add-steps">
        {' '}
        Open{' '}
        <a
          href="streamdeck://"
          class="app-link"
          title="Open Elgato Stream Deck"
          onClick={openSdApp}
        >
          Stream Deck
        </a>{' '}
        app:
        <ol class="manual-add-list">
          <li>
            Navigate to the <span class="nstrong">top-left corner</span> of the Elgato app to locate
            the device drop-down menu.
          </li>
          <li>
            Open the drop-down menu, scroll to the bottom and select{' '}
            <span class="nstrong">Add Network Device…</span>, then enter this address:
          </li>
        </ol>
      </div>
      <div class="addr-row">
        <CopyChip label="IP" value={ip} cls="addr-chip" pending={pending} />
        <span class="step-sub">Or use local IP if everything is on the same machine:</span>
        <CopyChip label="IP" value="127.0.0.1" cls="addr-port-chip" />
        <span> : </span>
        <CopyChip label="Port" value={CORA_PORT} cls="addr-port-chip" />
      </div>
    </div>
  );
}

export function KeyGridPreview({
  keyCount,
  columns,
  dimmed,
  modelId,
}: Readonly<{
  keyCount: number;
  columns: number;
  dimmed: boolean;
  modelId?: string;
}>): preact.JSX.Element {
  const isCompact = keyCount === 6;
  const gridRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<KeyPreview | null>(null);

  /* eslint-disable @eslint-react/exhaustive-deps -- intentional mount-only: creates KeyPreview once; prop changes handled by the effect below */
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    // Create the KeyPreview instance once; broadcast() auto-prunes on disconnect
    const kp = new KeyPreview(el, {});
    previewRef.current = kp;
    kp.setModel(modelId);
    kp.rebuild(keyCount, columns);
  }, []);
  /* eslint-enable @eslint-react/exhaustive-deps */

  // Update model + rebuild on prop changes
  useEffect(() => {
    const kp = previewRef.current;
    if (!kp) return;
    kp.setModel(modelId);
    kp.rebuild(keyCount, columns);
  }, [keyCount, columns, modelId]);

  const cls = 'preview' + (isCompact ? ' compact' : '') + (dimmed ? ' dimmed' : '');

  return (
    <div class={cls}>
      <div class="preview-head">
        <span class="preview-label">Live preview</span>
        <span class="live-dot">{dimmed ? 'Paused' : 'Live'}</span>
      </div>
      <div ref={gridRef} />
    </div>
  );
}

let _brightnessDebounce: ReturnType<typeof setTimeout> | null = null;

export function Brightness(): preact.JSX.Element {
  const brightness = useStore((s) => s.brightness);
  const brightnessOverride = useStore((s) => s.brightnessOverride);

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
    _brightnessDebounce = setTimeout(() => {
      fetch('/api/brightness', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: v }),
      }).catch(() => undefined);
    }, 100);
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

  return (
    <div class="brightness-block">
      <div class="brightness">
        <span class="b-label">Brightness</span>
        <Icon class="b-ico" html={ICON.sun} />
        <div class="fader">
          <input
            type="range"
            class="range"
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
      </div>
      <label class="b-ignore">
        <input
          type="checkbox"
          id="simple-brightness-ignore"
          checked={brightnessOverride}
          onChange={postBrightnessOverride}
        />
        <span class="b-ignore-label">Ignore brightness from Elgato app</span>
      </label>
    </div>
  );
}
