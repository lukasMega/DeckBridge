// Push API state: the channel store, token admin and the coalesced repaint/broadcast.
import {
  PUSH_TOKENS_MAX,
  PUSH_TOKEN_NAME_MAX,
  generatePushToken,
  hashPushToken,
  newTokenId,
  type PushTokenRecord,
} from '../../infra/push-tokens.js';
import { PushChannels, pushChannels } from '../../shared/push-channels.js';
import {
  pushBodyError,
  sanitizePushText,
  toPushInput,
  type PushInput,
} from '../../shared/push-text.js';
import { log } from '../../shared/logger.js';
import type { DockStatus } from '../../shared/types.js';
import type {
  PushChannelView,
  PushErrorCode,
  PushResult,
  PushTokenCreated,
  PushTokenView,
} from '../contract.js';
import { PushRateLimits } from './push-rate-limit.js';
import type { ControllerHost, ReqError } from './types.js';

/** Trailing coalesce for device repaints (caps push-driven paints at ~20/s per dock). */
export const PUSH_REPAINT_COALESCE_MS = 50;
const PUSH_BROADCAST_COALESCE_MS = 250;

export type PushFailure = { status: number; code: PushErrorCode; error: string };

export class PushController {
  readonly limits: PushRateLimits;
  private readonly lastUsed = new Map<string, number>();
  private repaintTimer: ReturnType<typeof setTimeout> | undefined;
  private broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly host: ControllerHost,
    private readonly docks: () => readonly DockStatus[],
    private readonly store: PushChannels = pushChannels,
    limits: PushRateLimits = new PushRateLimits(),
    private readonly now: () => number = Date.now,
  ) {
    this.limits = limits;
    this.unsubscribe = store.onChange(() => this.scheduleChanged());
  }

  dispose(): void {
    this.unsubscribe();
    clearTimeout(this.repaintTimer);
    clearTimeout(this.broadcastTimer);
    this.repaintTimer = undefined;
    this.broadcastTimer = undefined;
  }

  /** Validate, sanitize and store a push body (token route and WebUI "Send test"). */
  push(channel: string, body: unknown): PushResult | PushFailure {
    const invalid = pushBodyError(body);
    if (invalid) return { status: 400, code: 'invalid_field', error: invalid };
    const input = toPushInput(body);
    const clean = sanitizePushText(input.text);
    const stored: PushInput = { ...input, text: clean.text };
    const value = this.store.set(channel, stored, this.now());
    if (value === 'full') {
      return { status: 409, code: 'channel_limit', error: 'too many active channels' };
    }
    log('debug', 'push', `push: ${channel} bound=${this.bound(channel)}`);
    return {
      ok: true,
      channel,
      expiresAt: value.expiresAt,
      bound: this.bound(channel),
      replaced: clean.replaced,
      truncated: clean.truncated,
    };
  }

  clear(channel: string): void {
    this.store.clear(channel);
  }

  channels(): PushChannelView[] {
    return this.store.list().map(({ channel, value }) => ({
      channel,
      text: value.text,
      ...(value.color ? { color: value.color } : {}),
      ...(value.background ? { background: value.background } : {}),
      updatedAt: value.updatedAt,
      expiresAt: value.expiresAt,
      bound: this.bound(channel),
    }));
  }

  records(): readonly PushTokenRecord[] {
    return this.host.settings.pushTokenRecords();
  }

  tokens(): PushTokenView[] {
    return this.records().map((r) => this.view(r));
  }

  async createToken(name: unknown): Promise<PushTokenCreated | ReqError> {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (trimmed.length < 1 || trimmed.length > PUSH_TOKEN_NAME_MAX) {
      return { status: 400, error: `name must be 1–${PUSH_TOKEN_NAME_MAX} characters` };
    }
    const records = this.records();
    if (records.length >= PUSH_TOKENS_MAX) {
      return { status: 409, error: `at most ${PUSH_TOKENS_MAX} tokens` };
    }
    const { token, prefix } = generatePushToken();
    const record: PushTokenRecord = {
      id: newTokenId(),
      name: trimmed,
      scopes: ['push'],
      hash: await hashPushToken(token),
      prefix,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.host.settings.setPushTokens([...this.records(), record]);
    log('info', 'push', `push token created: ${record.name} (${record.id})`);
    return { ...this.view(record), token };
  }

  async rotateToken(id: string): Promise<PushTokenCreated | ReqError> {
    const old = this.records().find((r) => r.id === id);
    if (!old) return { status: 404, error: 'no such token' };
    const { token, prefix } = generatePushToken();
    const record: PushTokenRecord = { ...old, hash: await hashPushToken(token), prefix };
    this.host.settings.setPushTokens(this.records().map((r) => (r.id === id ? record : r)));
    log('info', 'push', `push token rotated: ${old.name} (${id})`);
    return { ...this.view(record), token };
  }

  revokeToken(id: string): ReqError | null {
    const old = this.records().find((r) => r.id === id);
    if (!old) return { status: 404, error: 'no such token' };
    this.host.settings.setPushTokens(this.records().filter((r) => r.id !== id));
    this.lastUsed.delete(id);
    log('info', 'push', `push token revoked: ${old.name} (${id})`);
    return null;
  }

  noteUsed(tokenId: string): void {
    this.lastUsed.set(tokenId, this.now());
  }

  private view(r: PushTokenRecord): PushTokenView {
    const lastUsedAt = this.lastUsed.get(r.id);
    return {
      id: r.id,
      name: r.name,
      scopes: r.scopes,
      prefix: r.prefix,
      createdAt: r.createdAt,
      ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
    };
  }

  /** Keys and strip zones on connected docks that show `channel`. */
  private bound(channel: string): number {
    let n = 0;
    for (const d of this.docks()) {
      if (!d.deviceKey) continue;
      const wireIds = new Set<number>([
        ...(d.extraKeys ?? []),
        ...(d.widgetDisplays ?? []).map((w) => w.wireId),
      ]);
      const configs = this.host.settings.for(d.deviceKey).extraKeyConfigs();
      for (const [wire, cfg] of Object.entries(configs)) {
        if (cfg.widget === 'external' && cfg.param === channel && wireIds.has(Number(wire))) n++;
      }
    }
    return n;
  }

  private scheduleChanged(): void {
    this.repaintTimer ??= setTimeout(() => {
      this.repaintTimer = undefined;
      this.host.emit('pushChanged');
    }, PUSH_REPAINT_COALESCE_MS);
    this.broadcastTimer ??= setTimeout(() => {
      this.broadcastTimer = undefined;
      this.host.broadcast('pushChannels', { channels: this.channels() });
    }, PUSH_BROADCAST_COALESCE_MS);
  }
}
