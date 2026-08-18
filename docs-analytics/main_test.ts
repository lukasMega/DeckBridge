// Round-trip tests for the collector: encode a beacon exactly as the client
// does, feed it through createHandler over an in-memory KV, then assert /stats.
// Run: deno task test
import { assertEquals } from "@std/assert";
import { botKind, createHandler, eq, parseUA, refGroup } from "./main.ts";

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

Deno.test("pageview writes a true day×hour joint counter", async () => {
  const { kv, h } = await fixture();
  await h(beacon(encode({ p: "/" })));
  const stats = await (await h(statsReq(""))).json();

  const now = new Date();
  const key = `${now.getUTCDay()}-${String(now.getUTCHours()).padStart(2, "0")}`;
  assertEquals(Object.keys(stats.dowhour), [key]);
  assertEquals(stats.dowhour[key], 1);
  // the joint key's hour half must agree with the standalone `hour` marginal
  assertEquals(Object.keys(stats.hour)[0], key.split("-")[1]);
  kv.close();
});

Deno.test("ref_group is classified at ingest; empty referrer counts as direct", async () => {
  const { kv, h } = await fixture();
  await h(beacon(encode({ p: "/", r: "www.google.co.uk" })));
  await h(beacon(encode({ p: "/", r: "news.ycombinator.com" })));
  await h(beacon(encode({ p: "/", r: "" }))); // client sends "" for direct
  await h(beacon(encode({ p: "/", r: "someblog.dev" })));
  await h(beacon(encode({ p: "/", r: "docs.x.dev", h: "https://docs.x.dev" })));

  const stats = await (await h(statsReq(""))).json();
  assertEquals(stats.ref_group, {
    search: 1,
    social: 1,
    direct: 1,
    referral: 1,
    internal: 1,
  });
  assertEquals(stats.ref.direct, 1); // "" normalized, not stored as an empty key
  kv.close();
});

Deno.test("refGroup buckets hosts", () => {
  assertEquals(refGroup("", ""), "direct");
  assertEquals(refGroup("direct", ""), "direct");
  assertEquals(refGroup("news.google.com", ""), "search");
  assertEquals(refGroup("duckduckgo.com", ""), "search");
  assertEquals(refGroup("t.co", ""), "social");
  assertEquals(refGroup("www.reddit.com", ""), "social");
  assertEquals(refGroup("example.com", ""), "referral");
  assertEquals(refGroup("docs.x.dev", "https://docs.x.dev"), "internal");
  assertEquals(refGroup("docs.x.dev", "docs.x.dev"), "internal");
  assertEquals(refGroup("googleblog.com", ""), "referral"); // not a search engine
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

Deno.test("bots are skipped, but counted (not silently dropped)", async () => {
  const { kv, h } = await fixture();
  await h(beacon(encode({ p: "/" }), "curl/8.0"));
  const stats = await (await h(statsReq(""))).json();
  assertEquals(stats.pv, undefined);
  assertEquals(stats.bot.ua, 1);
  assertEquals(Object.keys(stats.bot_kind).length > 0, true);
  kv.close();
});

Deno.test("series carries a per-day bot total alongside the human metrics", async () => {
  const { kv, h } = await fixture();
  await h(beacon(encode({ p: "/", u: "1", s: "1" })));
  await h(beacon(encode({ p: "/" }), "curl/8.0")); // ua bot
  await h(beacon(encode({ ev: "bot", t: "synthetic" }))); // probe verdict

  const day = new Date().toISOString().slice(0, 10);
  const stats = await (await h(statsReq(`series=1&from=${day}&to=${day}`))).json();
  // [day, pv, uv, sessions, bot] — bot is ua + synthetic, and pv excludes both
  assertEquals(stats.series, [[day, 1, 1, 1, 2]]);
  kv.close();
});

Deno.test("isbot catches JS-capable bots the old hand-rolled regex missed", async () => {
  const { kv, h } = await fixture();
  // facebookexternalhit doesn't contain "bot"/"crawl"/"spider"/... — the old
  // regex let it through as a real pageview. isbot knows it.
  await h(beacon(encode({ p: "/" }), "facebookexternalhit/1.1"));
  const stats = await (await h(statsReq(""))).json();
  assertEquals(stats.pv, undefined);
  assertEquals(stats.bot.ua, 1);
  kv.close();
});

Deno.test("a normal browser UA is not counted as a bot", async () => {
  const { kv, h } = await fixture();
  await h(beacon(encode({ p: "/" }), "Mozilla/5.0 (Windows NT 10.0) Firefox/126.0"));
  const stats = await (await h(statsReq(""))).json();
  assertEquals(stats.pv._, 1);
  assertEquals(stats.bot, undefined);
  kv.close();
});

Deno.test("behavioral probe lands in its own dim, not `event`", async () => {
  const { kv, h } = await fixture();
  await h(beacon(encode({ ev: "hi", t: "150-2000" })));
  const stats = await (await h(statsReq(""))).json();
  assertEquals(stats.hi["150-2000"], 1);
  assertEquals(stats.pv, undefined);
  // must NOT pollute the real-interaction dims (download/outbound live there)
  assertEquals(stats.event, undefined);
  assertEquals(stats.event_target, undefined);
  kv.close();
});

Deno.test("botKind names the crawler, version-free", () => {
  // isbotMatch alone would return "Google" / "Bot" / "facebookexternalhit/1.1"
  const k = (ua: string) => botKind(`Mozilla/5.0 (compatible; ${ua}; +http://x)`);
  assertEquals(k("Googlebot/2.1"), "googlebot");
  assertEquals(k("ClaudeBot/1.0"), "claudebot"); // isbotMatch alone: "Bot"
  assertEquals(k("GPTBot/1.2"), "gptbot"); // isbotMatch alone: "Bot"
  assertEquals(botKind("Mozilla/5.0 (Macintosh) Chrome-Lighthouse"), "chrome-lighthouse");
  // same crawler, two versions → one row, not two
  assertEquals(botKind("facebookexternalhit/1.1"), botKind("facebookexternalhit/2.0"));
  assertEquals(botKind("facebookexternalhit/1.1"), "facebookexternalhit");
  assertEquals(botKind("Mozilla/5.0 Firefox/126.0"), "unknown"); // not a bot
});

Deno.test("untrusted-event verdict counts as bot=synthetic", async () => {
  const { kv, h } = await fixture();
  await h(beacon(encode({ ev: "bot", t: "synthetic" })));
  const stats = await (await h(statsReq(""))).json();
  assertEquals(stats.bot.synthetic, 1);
  assertEquals(stats.pv, undefined);
  assertEquals(stats.event, undefined);
  kv.close();
});

Deno.test("real interaction events still use event/event_target", async () => {
  const { kv, h } = await fixture();
  await h(beacon(encode({ ev: "outbound", t: "github.com" })));
  const stats = await (await h(statsReq(""))).json();
  assertEquals(stats.event.outbound, 1);
  assertEquals(stats.event_target["github.com"], 1);
  assertEquals(stats.hi, undefined);
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
