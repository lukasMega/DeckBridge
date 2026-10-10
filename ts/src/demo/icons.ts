export function renderIcon(
  index: number,
  presses: number,
  w: number,
  h: number,
): OffscreenCanvas | null {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = `hsl(${(index * 47 + presses * 70) % 360} 70% 45%)`;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'white';
  ctx.font = `bold ${Math.round(Math.min(w, h) * 0.55)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(index + 1), w / 2, h / 2);
  return canvas;
}

export async function iconToBase64Jpeg(canvas: OffscreenCanvas | null): Promise<string | null> {
  if (!canvas) return null;
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}
