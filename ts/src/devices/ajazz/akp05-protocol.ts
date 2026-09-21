const PACKET_SIZE = 1024;

export const AKP05_COMMANDS = Object.freeze({
  VER: Object.freeze([0x56, 0x45, 0x52]),
  LIG: Object.freeze([0x4c, 0x49, 0x47]),
  BAT: Object.freeze([0x42, 0x41, 0x54]),
  ULEND: Object.freeze([0x55, 0x4c, 0x45, 0x4e, 0x44]),
});

const CRT_PREFIX = Object.freeze([0x43, 0x52, 0x54, 0x00, 0x00]);

export function buildPacket(command: readonly number[], extra: readonly number[] = []): Buffer {
  const packet = Buffer.alloc(PACKET_SIZE);
  packet.set(CRT_PREFIX, 0);
  packet.set(command, 5);
  packet.set(extra, 5 + command.length);
  return packet;
}

export function buildVer(): Buffer {
  return buildPacket(AKP05_COMMANDS.VER);
}

export function buildLig(brightness: number): Buffer {
  return buildPacket(AKP05_COMMANDS.LIG, [0, 0, brightness]);
}

export function buildBat(jpegLength: number, surfaceId: number): Buffer {
  if (!Number.isInteger(jpegLength) || jpegLength < 0 || jpegLength > 0xffff) {
    throw new RangeError(`AKP05 JPEG length must fit BE16: ${jpegLength}`);
  }
  return buildPacket(AKP05_COMMANDS.BAT, [0, 0, jpegLength >> 8, jpegLength & 0xff, surfaceId]);
}

export function buildUlend(): Buffer {
  return buildPacket(AKP05_COMMANDS.ULEND);
}

export function imageChunks(jpeg: Uint8Array): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < jpeg.length; offset += PACKET_SIZE) {
    const chunk = Buffer.alloc(PACKET_SIZE);
    chunk.set(jpeg.subarray(offset, offset + PACKET_SIZE));
    chunks.push(chunk);
  }
  return chunks;
}

export function parseVersionReport(report: Uint8Array): string | undefined {
  const text = Buffer.from(report).toString('ascii');
  const start = text.indexOf('V');
  if (start < 0 || !isDigit(text.charCodeAt(start + 1))) return undefined;
  let end = start + 2;
  while (isVersionCharacter(text.charCodeAt(end))) end++;
  return text.slice(start, end);
}

function isDigit(char: number): boolean {
  return char >= 0x30 && char <= 0x39;
}

function isVersionCharacter(char: number): boolean {
  return (
    isDigit(char) ||
    (char >= 0x41 && char <= 0x5a) ||
    (char >= 0x61 && char <= 0x7a) ||
    char === 0x2d ||
    char === 0x2e ||
    char === 0x5f
  );
}

export function describePacket(packet: Uint8Array): string {
  if (packet[0] !== 0x43 || packet[1] !== 0x52 || packet[2] !== 0x54) return 'image-data chunk';
  const command = Buffer.from(packet.subarray(5, 10)).toString('ascii').replaceAll('\0', '');
  if (command === 'BAT')
    return `CRT BAT jpegLen=${(packet[10]! << 8) | packet[11]!} surface=${packet[12]}`;
  if (command === 'LIG') return `CRT LIG brightness=${packet[10]}`;
  return `CRT ${command}`;
}
