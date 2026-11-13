import { expect, type APIRequestContext } from '@playwright/test';

/**
 * HTTP helpers for arranging app state from a spec.
 *
 * Everything goes through Playwright's own request context, never an in-page `fetch`:
 * a long series of page-side fetches leaves the Lightpanda session unable to navigate
 * again, which wedges whichever spec runs next.
 */

export interface ApiResult<T = Record<string, unknown>> {
  status: number;
  json: T;
}

/** GET `path`, or POST `body` as JSON when given. Non-JSON bodies (204) come back as `{}`. */
export async function api<T = Record<string, unknown>>(
  request: APIRequestContext,
  baseURL: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const url = `${baseURL}${path}`;
  const res = body === undefined ? await request.get(url) : await request.post(url, { data: body });
  const text = await res.text();
  return { status: res.status(), json: (text ? JSON.parse(text) : {}) as T };
}

/** The subset of GET /api/state the helpers read (full shape: ts/src/web/contract.ts). */
export interface AppState {
  driverMode: 'real' | 'mock';
  driverConnected: boolean;
  elgatoConnected: boolean;
  modelId: string;
  modelName: string;
  keyCount: number;
  columns: number;
  rows: number;
  [key: string]: unknown;
}

export async function getState(request: APIRequestContext, baseURL: string): Promise<AppState> {
  return (await api<AppState>(request, baseURL, '/api/state')).json;
}

/** Poll GET /api/state until `predicate` holds; returns the matching state. */
export async function waitForState(
  request: APIRequestContext,
  baseURL: string,
  predicate: (state: AppState) => boolean,
  timeout = 20_000,
): Promise<AppState> {
  let last: AppState | undefined;
  await expect
    .poll(
      async () => {
        last = await getState(request, baseURL);
        return predicate(last);
      },
      { timeout },
    )
    .toBe(true);
  return last!;
}

/** Wait until the mock driver is connected again. A 'reopen' change really does drop
 *  and re-open the session, and the app server is shared with every later spec, so no
 *  test may leave it mid-reconnect. */
export function waitForDriver(request: APIRequestContext, baseURL: string): Promise<AppState> {
  return waitForState(request, baseURL, (s) => s.driverConnected);
}

/**
 * Switch the mock device in place (one app per worker: CORA ports are fixed, so the
 * suite cannot boot one instance per model). Resolves once the new model is live.
 */
export async function useDevice(
  request: APIRequestContext,
  baseURL: string,
  modelId: string,
): Promise<AppState> {
  const res = await api(request, baseURL, '/api/device-model', { modelId });
  expect(res.status, `POST /api/device-model ${modelId}`).toBe(200);
  return waitForState(request, baseURL, (s) => s.modelId === modelId && s.driverConnected);
}
