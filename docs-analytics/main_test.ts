// Round-trip tests for the collector: encode a beacon exactly as the client
// does, feed it through createHandler over an in-memory KV, then assert /stats.
// Run: deno task test
import { assertEquals } from "jsr:@std/assert@1";
import { createHandler, eq, parseUA } from "./main.ts";

Deno.env.set("STATS_TOKEN", "testtoken");

// mirror docs-site/src/analytics.ts send(): base64(encodeURIComponent(JSON))
const encode = (p: Record<string, string>) =>
  btoa(encodeURIComponent(JSON.stringify(p)));

function fixture() {
  const kv = Deno.openKv(":memory:");
  return kv.then((k) => ({ kv: k, h: createHandler(k) }));
}

const beacon = (v: string, ua = "Mozilla/5.0 (Windows NT 10.0) Firefox/126.0") =>
  new Request(`http://x/e?v=${encodeURIComponent(v)}`, {
    headers: { "user-agent": ua },
  });

const statsReq = (qs: string, token = "testtoken") =>
  new Request(`http://x/stats?${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  });

Deno.test("pageview writes pv + derived dims", async () => {
  const { kv, h } = await fixture();
  const res = await h(beacon(encode({ p: "/docs/intro", l: "de-DE", tz: "Europe/Berlin" })));
  assertEquals(res.headers.get("content-type"), "image/gif");

  const stats = await (await h(statsReq(""))).json();
  assertEquals(stats.pv._, 1);
  assertEquals(stats.path["/docs/intro"], 1);
  assertEquals(stats.browser.Firefox, 1);
  assertEquals(stats.os.Windows, 1);
  assertEquals(stats.lang.de, 1);
  assertEquals(Object.keys(stats.hour).length, 1); // one UTC-hour bucket
  kv.close();
});

Deno.test("event beacon does not increment pv", async () => {
  const { kv, h } = await fixture();
  await h(beacon(encode({ ev: "download", t: "deckbridge.zip" })));
  const stats = await (await h(statsReq(""))).json();
  assertEquals(stats.pv, undefined);
  assertEquals(stats.event.download, 1);
  assertEquals(stats.event_target["deckbridge.zip"], 1);
  kv.close();
});

Deno.test("bots are skipped", async () => {
  const { kv, h } = await fixture();
  await h(beacon(encode({ p: "/" }), "curl/8.0"));
  const stats = await (await h(statsReq(""))).json();
  assertEquals(stats.pv, undefined);
  kv.close();
});

Deno.test("oversized dim values are clamped to 128 chars", async () => {
  const { kv, h } = await fixture();
  await h(beacon(encode({ p: "/" + "a".repeat(500) })));
  const stats = await (await h(statsReq(""))).json();
  const key = Object.keys(stats.path)[0];
  assertEquals(key.length, 128);
  kv.close();
});

Deno.test("stats auth: 401 without token, ok via header and via query", async () => {
  const { kv, h } = await fixture();
  assertEquals((await h(new Request("http://x/stats"))).status, 401);
  assertEquals((await h(statsReq("", "wrong"))).status, 401);
  assertEquals((await h(statsReq(""))).status, 200);
  assertEquals((await h(new Request("http://x/stats?token=testtoken"))).status, 200);
  kv.close();
});

Deno.test("parseUA classifies browser/os/device", () => {
  assertEquals(parseUA("... SamsungBrowser/23 Chrome/...").browser, "Samsung Internet");
  assertEquals(parseUA("... Edg/120 Chrome/...").browser, "Edge");
  assertEquals(parseUA("iPhone ... Mobile Safari").device, "mobile");
  assertEquals(parseUA("iPad ... Safari").device, "tablet");
});

Deno.test("eq is length-safe constant-ish compare", () => {
  assertEquals(eq("abc", "abc"), true);
  assertEquals(eq("abc", "abd"), false);
  assertEquals(eq("abc", "ab"), false);
});
