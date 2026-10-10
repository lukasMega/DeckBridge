// Injected by scripts/build-demo.mjs: the WebUI's free `fetch` / `WebSocket` references
// resolve here, so the app's client code stays as shipped and talks to the in-browser backend.
import { backend } from './install.js';
import { FakeSocket } from './socket.js';

export function fetch(input: string, init?: RequestInit): Promise<Response> {
  return backend.fetch(input, init);
}

export class WebSocket extends FakeSocket {
  constructor(_url: string) {
    super();
    backend.openSocket(this);
  }
}
