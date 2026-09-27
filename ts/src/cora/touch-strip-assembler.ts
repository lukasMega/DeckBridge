// Stream Deck + touch/LCD output (0x08 LCD, 0x0B window strip, 0x0C partial window)
// for the child CORA server. Only the strip commands have a device surface; the
// 800×480 LCD is dropped with a trace.
import { IMG_CMD_LCD, IMG_CMD_WINDOW_PARTIAL } from './protocol.js';
import type { TouchWindowRegion } from '../shared/types.js';
import { isLevelEnabled } from '../shared/logger.js';
import {
  assembleImageChunk,
  assemblePartialWindowChunk,
  type ImageAssembly,
} from './image-assembler.js';
import type { LogFn } from './types.js';

export interface TouchImageEvent {
  data: Buffer;
  region?: TouchWindowRegion;
}

export class TouchStripAssembler {
  private windowPages = new Map<number, ImageAssembly>();
  private partialPages = new Map<string, ImageAssembly>();

  reset(): void {
    this.windowPages = new Map();
    this.partialPages = new Map();
  }

  /** Feed one chunk; returns the assembled image once the last chunk lands. */
  accept(cmd: number, pkt: Buffer, emitLog: LogFn): TouchImageEvent | null {
    // Hex dumps only at debug: these chunks ride the ACK-paced path.
    const tracing = isLevelEnabled('debug');
    if (cmd === IMG_CMD_LCD) {
      if (tracing) {
        emitLog(
          'debug',
          `child rx: LCD output dropped (no 800×480 surface): ${(pkt.subarray(0, 16) as Buffer).toString('hex')}`,
        );
      }
      return null;
    }
    if (cmd === IMG_CMD_WINDOW_PARTIAL) {
      const region = assemblePartialWindowChunk(this.partialPages, pkt);
      if (!region) return null;
      if (tracing) {
        emitLog(
          'debug',
          `child rx: partial window assembled ${region.w}×${region.h} @ ${region.x},${region.y} (${region.data.length} B)`,
        );
      }
      return { data: region.data, region: { x: region.x, y: region.y, w: region.w, h: region.h } };
    }
    // 0x0B window strip — assemble as a gen2 image chunk (assumed layout).
    if (tracing) {
      emitLog(
        'debug',
        `child rx: window-strip chunk: ${(pkt.subarray(0, 8) as Buffer).toString('hex')}`,
      );
    }
    const assembled = assembleImageChunk(this.windowPages, pkt);
    if (!assembled) return null;
    if (tracing) emitLog('debug', `child rx: window strip assembled ${assembled.data.length} B`);
    return { data: assembled.data };
  }
}
