export function renderZone(
  index: number,
  value: number,
  hue: number,
  flash: boolean,
  w: number,
  h: number,
): OffscreenCanvas | null {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const canvas = new OffscreenCanvas(w, h);
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = `hsl(${hue}, 70%, ${flash ? 70 : 35}%)`;
  context.fillRect(0, 0, w, h);
  context.fillStyle = 'white';
  context.textAlign = 'center';
  context.font = `bold ${Math.round(h * 0.16)}px sans-serif`;
  context.fillText(`Knob ${index + 1}`, w / 2, h * 0.25);
  context.font = `bold ${Math.round(h * 0.45)}px sans-serif`;
  context.fillText(String(value), w / 2, h * 0.8);
  return canvas;
}
