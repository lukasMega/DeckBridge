// A bare HTTP/1.1 GET over TCP. txiki's fetch rejects a 304 reply ("Network request failed"),
// so conditional-request tests read the response head off the socket instead.

export interface RawHead {
  status: number;
  headers: Map<string, string>;
}

export async function rawHead(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<RawHead> {
  const sock = await tjs.connect('tcp', '127.0.0.1', port);
  const { readable, writable } = await sock.opened;
  const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close'];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  const writer = writable.getWriter();
  await writer.write(new TextEncoder().encode(`${lines.join('\r\n')}\r\n\r\n`));
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let head = '';
  try {
    while (!head.includes('\r\n\r\n')) {
      const { done, value } = await reader.read();
      if (done) break;
      head += decoder.decode(value, { stream: true });
    }
  } finally {
    sock.close();
  }
  const [statusLine = '', ...rest] = head.split('\r\n\r\n')[0]!.split('\r\n');
  const map = new Map<string, string>();
  for (const line of rest) {
    const i = line.indexOf(':');
    if (i > 0) map.set(line.slice(0, i).toLowerCase(), line.slice(i + 1).trim());
  }
  return { status: Number(statusLine.split(' ')[1]), headers: map };
}
