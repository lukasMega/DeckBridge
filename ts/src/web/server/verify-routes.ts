// /api/verify/*: the device verify wizard (verify-controller.ts, ../contract-verify.ts).
import { get, postJson } from './router.js';
import type { Route } from './router.js';
import { badRequest, json } from './http.js';
import { isNonNegInt, nonNegIntMessage } from './types.js';
import type { ReqError } from './types.js';
import type { VerifyError, VerifyRawBody, VerifySaveInput } from './verify-controller.js';
import type {
  VerifyDismissBody,
  VerifyDraftBody,
  VerifyPaintBody,
  VerifyStartResponse,
} from '../contract-verify.js';

type TokenBody = VerifyRawBody<Pick<VerifyStartResponse, 'token'>>;

function fail(e: VerifyError): Response {
  return json({ error: e.error, ...(e.reason ? { reason: e.reason } : {}) }, e.status);
}

const okOr = (err: ReqError | null): Response => (err ? fail(err) : json({ ok: true }));

export const verifyRoutes: Route[] = [
  get('/api/verify/spec', ({ verify, url, ui }) => {
    const raw = url.searchParams.get('dock');
    const dock = raw === null || raw === '' ? ui.selectedDock : Number(raw);
    if (!isNonNegInt(dock)) return badRequest(nonNegIntMessage('dock'));
    return json(verify.spec(dock));
  }),
  postJson('/api/verify/start', (body: { dockIndex?: unknown }, { verify }) => {
    const r = verify.start(body.dockIndex);
    return 'error' in r ? fail(r) : json(r);
  }),
  postJson('/api/verify/keepalive', (body: TokenBody, { verify }) => {
    const r = verify.keepalive(body.token);
    return 'error' in r ? fail(r) : json(r);
  }),
  postJson('/api/verify/paint', (body: VerifyRawBody<VerifyPaintBody>, { verify }) =>
    okOr(verify.paint(body.token, body.keys)),
  ),
  postJson('/api/verify/draft', (body: VerifyRawBody<VerifyDraftBody>, { verify }) =>
    okOr(verify.draft(body.token, body.image)),
  ),
  postJson('/api/verify/save', (body: VerifySaveInput, { verify }) => {
    const r = verify.save(body);
    return 'error' in r ? fail(r) : json(r);
  }),
  postJson('/api/verify/end', (body: TokenBody, { verify }) => {
    verify.end(body.token);
    return json({ ok: true });
  }),
  postJson('/api/verify/dismiss', (body: VerifyRawBody<VerifyDismissBody>, { verify }) =>
    okOr(verify.dismiss(body.modelId, body.never)),
  ),
];
