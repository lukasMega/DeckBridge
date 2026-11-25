import { createKeyBackgroundRenderer } from '../devices/key-background-renderer.js';
import type { DockDriver } from '../devices/driver.js';
import type { KeyBackgroundFrame } from '../extension/api.js';
import { log } from '../shared/logger.js';
import type { LastFrames } from './dock-frames.js';
import type { DockStandby } from './dock-standby.js';
import type { DockHooks } from './dock-types.js';

export function startKeyBackground(
  driver: DockDriver,
  frames: LastFrames,
  standby: DockStandby,
  deviceKey: string | undefined,
  pull: DockHooks['pullKeyBackground'],
  attached: () => boolean,
  ownership: (owns: boolean) => void,
): void {
  if (!pull || !deviceKey || driver.model.id !== 'ajazz-akp05e') return;
  const canPaint = () =>
    !frames.held &&
    standby.display.effectiveBrightness > 0 &&
    (standby.state === 'active' || standby.state === 'dimmed');
  void playKeyBackground(driver, frames, () => pull(deviceKey), attached, canPaint, ownership);
}

function integerInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function valid(frame: KeyBackgroundFrame | null): frame is KeyBackgroundFrame {
  return (
    !!frame &&
    typeof frame.id === 'string' &&
    frame.id.length > 0 &&
    frame.id.length <= 96 &&
    integerInRange(frame.width, 1, 840) &&
    integerInRange(frame.height, 1, 472) &&
    frame.rgb instanceof Uint8Array &&
    frame.rgb.length === frame.width * frame.height * 3 &&
    integerInRange(frame.fps, 1, 31) &&
    integerInRange(frame.quality, 1, 100) &&
    integerInRange(frame.black, 0, 255)
  );
}

/** One serial pull per dock. Normal CORA output resumes as soon as the source yields. */
async function playKeyBackground(
  driver: DockDriver,
  frames: LastFrames,
  pull: () => Promise<KeyBackgroundFrame | null>,
  attached: () => boolean,
  canPaint: () => boolean,
  ownership: (owns: boolean) => void,
): Promise<void> {
  const renderer = createKeyBackgroundRenderer(driver);
  let owned = false;
  const release = () => {
    if (!owned) return;
    owned = false;
    ownership(false);
    renderer.reset();
    log('info', 'extensions', 'AKP05E key background released');
    if (attached() && canPaint()) frames.repaint(driver);
  };
  try {
    while (attached()) {
      const start = Date.now();
      const candidate = canPaint() ? await pull().catch(() => null) : null;
      if (!attached()) break;
      let delay = 250;
      if (canPaint() && valid(candidate)) {
        delay = 1000 / candidate.fps;
        try {
          renderer.render(candidate, (key) => frames.freshImage(key));
          if (!owned) {
            owned = true;
            ownership(true);
            log('info', 'extensions', 'AKP05E key background active (10 keys)');
          }
        } catch (error) {
          log('warn', 'extensions', `AKP05E key background: ${String(error)}`);
          if (owned) release();
          else frames.repaint(driver);
          delay = 250;
        }
      } else {
        release();
      }
      const deadline = start + delay;
      do {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.max(1, Math.ceil(deadline - Date.now()))),
        );
      } while (attached() && Date.now() < deadline);
    }
  } finally {
    release();
  }
}
