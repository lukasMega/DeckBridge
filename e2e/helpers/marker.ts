import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '@playwright/test';

/**
 * A shell command whose only effect is appending a line to a temp file, so a spec can
 * count how often the app ran it (press commands, knob commands, command-widget runs).
 * The app runs commands through the POSIX shell — the app suite runs on macOS/Linux.
 */
export class Marker {
  private readonly dir = mkdtempSync(join(tmpdir(), 'deckbridge-e2e-marker-'));
  readonly path = join(this.dir, 'runs');

  /** Appends one line per run; `echo` also gives a command widget something to show. */
  command(tag = 'run'): string {
    return `echo ${tag} >> '${this.path}'; echo ${tag}`;
  }

  count(): number {
    if (!existsSync(this.path)) return 0;
    return readFileSync(this.path, 'utf8').split('\n').filter(Boolean).length;
  }

  lines(): string[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
  }

  async waitForCount(atLeast: number, what: string): Promise<void> {
    await expect
      .poll(() => this.count(), { message: what, timeout: 10_000 })
      .toBeGreaterThanOrEqual(atLeast);
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
