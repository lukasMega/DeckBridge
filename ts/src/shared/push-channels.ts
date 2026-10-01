// In-memory push store: web server writes, widget scheduler reads (main thread only).
// Values are deliberately not persisted — the pusher is the source of truth.
import type { ExtraKeyTextStyle } from './types.js';
import { DEFAULT_TEXT_BACKGROUND, DEFAULT_TEXT_COLOR } from './extra-key-config.js';
import type { PushInput } from './push-text.js';

export const PUSH_CHANNELS_MAX = 64;

export interface PushedValue {
  text: string;
  color?: string;
  background?: string;
  updatedAt: number;
  /** null = never expires. */
  expiresAt: number | null;
}

export type ExternalView =
  | { state: 'waiting' }
  | { state: 'live'; value: PushedValue }
  | { state: 'expired'; value: PushedValue };

/** What the widget scheduler needs — a seam for tests. */
export interface PushChannelsReader {
  view(channel: string, nowMs: number): ExternalView;
}

function compareNames(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export class PushChannels implements PushChannelsReader {
  private readonly values = new Map<string, PushedValue>();
  private readonly listeners = new Set<(channel: string) => void>();

  constructor(private readonly maxChannels = PUSH_CHANNELS_MAX) {}

  /** Replace a channel's value; 'full' = at capacity with nothing expired to evict. */
  // eslint-disable-next-line sonarjs/function-return-type -- 'full' is a sentinel
  set(channel: string, input: PushInput, nowMs: number): PushedValue | 'full' {
    if (!this.values.has(channel) && this.values.size >= this.maxChannels) {
      const victim = this.oldestExpired(nowMs);
      if (victim === undefined) return 'full';
      this.values.delete(victim);
      this.notify(victim);
    }
    const value: PushedValue = {
      text: input.text,
      color: input.color,
      background: input.background,
      updatedAt: nowMs,
      expiresAt: input.ttlS === 0 ? null : nowMs + input.ttlS * 1000,
    };
    this.values.set(channel, value);
    this.notify(channel);
    return value;
  }

  /** Drop a channel; true when it existed. */
  clear(channel: string): boolean {
    const had = this.values.delete(channel);
    if (had) this.notify(channel);
    return had;
  }

  view(channel: string, nowMs: number): ExternalView {
    const value = this.values.get(channel);
    if (!value) return { state: 'waiting' };
    const expired = value.expiresAt !== null && nowMs >= value.expiresAt;
    return { state: expired ? 'expired' : 'live', value };
  }

  /** Every stored channel, sorted by name. */
  list(): Array<{ channel: string; value: PushedValue }> {
    return [...this.values.entries()]
      .toSorted(([a], [b]) => compareNames(a, b))
      .map(([channel, value]) => ({ channel, value }));
  }

  /** Fires after set/clear/evict with the channel name; returns an unsubscribe. */
  onChange(fn: (channel: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private oldestExpired(nowMs: number): string | undefined {
    let best: string | undefined;
    let bestAt = Infinity;
    for (const [channel, v] of this.values) {
      if (v.expiresAt !== null && v.expiresAt <= nowMs && v.expiresAt < bestAt) {
        best = channel;
        bestAt = v.expiresAt;
      }
    }
    return best;
  }

  private notify(channel: string): void {
    for (const fn of this.listeners) fn(channel);
  }
}

/** Process-wide store (main thread only). */
export const pushChannels = new PushChannels();

const channelByte = (h: string, i: number): number => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);

function blend(hex: string, toward: string): string {
  let out = '#';
  for (let i = 0; i < 3; i++) {
    out += Math.round((channelByte(hex, i) + channelByte(toward, i)) / 2)
      .toString(16)
      .padStart(2, '0');
  }
  return out;
}

/** The style with text (and outline) blended 50% toward the background: the "stale" look. */
export function dimStyle(style: ExtraKeyTextStyle): ExtraKeyTextStyle {
  const bg = style.background ?? DEFAULT_TEXT_BACKGROUND;
  const out: ExtraKeyTextStyle = { ...style, color: blend(style.color ?? DEFAULT_TEXT_COLOR, bg) };
  if (style.outline) out.outline = blend(style.outline, bg);
  return out;
}
