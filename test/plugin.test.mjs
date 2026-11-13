// Runs the balance and scheduled hooks the way new-api calls them: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let fetchLog = [];
let fetchReplies = [];
globalThis.utils = {
  unixNow: () => 1767225600, // 2026-01-01T00:00:00Z
  fetch(request) {
    fetchLog.push(request);
    if (fetchReplies.length === 0) throw new Error("unexpected fetch " + request.url);
    return fetchReplies.shift();
  },
};

const plugin = await import("../plugin.js");
const { meta, buildBalanceRequest, parseBalance, scheduled, checkKey, detectKind, decide } = plugin;

// A fake key built at runtime so no key-like literal sits in the repo.
const KEY = ["sk", "test", "0123456789abcdef"].join("-");

function reply(status, body) {
  return { status: status, headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) };
}

function fetched(status, body) {
  return { status: status, headers: { "Content-Type": "application/json" }, body: body };
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function ctxFor(baseUrl, config) {
  return deepFreeze({ baseUrl: baseUrl, credential: null, apiKey: KEY, config: config || {}, state: null });
}

// Drives a balance query like the host: build, then parse each reply, following next.
function query(baseUrl, config, replies) {
  const ctx = ctxFor(baseUrl, config);
  const sent = [];
  let request = buildBalanceRequest(ctx);
  let state = request.state;
  for (const r of replies) {
    sent.push(request);
    const out = parseBalance(deepFreeze(Object.assign({}, ctx, { state: state === undefined ? null : state })), deepFreeze(r));
    if (!out.next) return { sent: sent, result: out };
    request = out.next;
    state = out.state;
  }
  throw new Error("balance query did not finish after " + replies.length + " replies");
}

function runScheduled(baseUrl, config, keyStatus, disabledReason, replies) {
  fetchLog = [];
  fetchReplies = replies.slice();
  const ctx = { baseUrl: baseUrl, credential: null, apiKey: KEY, config: config || {}, reason: "timer", keyStatus: keyStatus };
  if (disabledReason !== undefined) ctx.disabledReason = disabledReason;
  const out = scheduled(deepFreeze(ctx));
  assert.equal(fetchReplies.length, 0, "every prepared reply was fetched");
  return out;
}

test("meta is a plain JSON literal the marketplace can read", () => {
  const source = readFileSync(new URL("../plugin.js", import.meta.url), "utf8");
  const block = source.match(/export const meta = (\{[\s\S]*?\n\});/);
  assert.ok(block, "meta block found");
  assert.deepEqual(JSON.parse(block[1]), meta);
  assert.equal(meta.apiVersion, 1);
  assert.equal(meta.version, "1.0.0");
  assert.match(meta.key, /^[a-z0-9]+_upstream_balance$/);
  assert.ok(meta.key.length <= 30);
  assert.equal(meta.channelTypes, undefined);
  assert.equal(meta.routes, undefined);
  // new-api rc.50's channel type picker reads plugin.models.length and crashes on null.
  assert.ok(Array.isArray(meta.models) && meta.models.length > 0);
  const paths = meta.relay.map((r) => r.incoming_path);
  assert.deepEqual(paths, ["/v1/chat/completions", "/v1/responses", "/v1/embeddings", "/v1/images/generations", "/v1/rerank", "/v1/models"]);
  for (const r of meta.relay) assert.equal(r.converter, undefined, "relay routes pass through");
});

test("plugin key and author match the changelog and readme", () => {
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  assert.match(changelog, new RegExp("plugin: " + meta.key + "\\n"));
  assert.match(changelog, /version: 1\.0\.0\n/);
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes(meta.key));
});

test("known vendor hosts select their kind", () => {
  assert.equal(detectKind("https://api.deepseek.com"), "deepseek");
  assert.equal(detectKind("https://api.moonshot.cn"), "moonshot");
  assert.equal(detectKind("https://api.moonshot.ai"), "moonshot");
  assert.equal(detectKind("https://api.siliconflow.cn"), "siliconflow");
  assert.equal(detectKind("https://openrouter.ai/api"), "openrouter");
  assert.equal(detectKind("https://notdeepseek.com"), "");
  assert.equal(detectKind("https://relay.example.com"), "");
});

test("requests carry the key as a bearer token and nothing else secret", () => {
  const req = buildBalanceRequest(ctxFor("https://api.deepseek.com", {}));
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/user/balance");
  assert.equal(req.headers.Authorization, "Bearer " + KEY);
  assert.deepEqual(req.state, { kind: "deepseek", step: 0, probes: null });
});

test("an empty key fails the query with a reason", () => {
  assert.throws(() => buildBalanceRequest({ baseUrl: "https://x.example", credential: null, apiKey: "", config: {}, state: null }), /channel key is empty/);
});

test("New API: key quota over quota_per_unit, capped by the owner's quota", () => {
  const { sent, result } = query("https://relay.example.com", { upstreamKind: "newapi" }, [
    reply(200, { code: true, message: "ok", data: { object: "token_usage", total_available: 2500000, unlimited_quota: false } }),
    reply(200, { success: true, data: { quota_per_unit: 500000 } }),
  ]);
  assert.deepEqual(sent.map((s) => s.path), ["/api/usage/token/", "/api/status"]);
  assert.deepEqual(result, { amount: 5, currency: "USD" });

  const capped = query("https://relay.example.com", { upstreamKind: "newapi" }, [
    reply(200, { code: true, data: { total_available: 0, unlimited_quota: true, user_quota: { total_available: 750000 } } }),
    reply(200, { data: { quota_per_unit: 500000 } }),
  ]);
  assert.deepEqual(capped.result, { amount: 1.5, currency: "USD" });
});

test("New API: an unlimited key without the owner's quota is an error, not a balance", () => {
  const { result } = query("https://relay.example.com", { upstreamKind: "newapi" }, [
    reply(200, { code: true, data: { total_available: 0, unlimited_quota: true } }),
  ]);
  assert.match(result.error, /unlimited quota/);
});

test("New API: failures carry the status and the upstream message", () => {
  const { result } = query("https://relay.example.com", { upstreamKind: "newapi" }, [
    reply(401, { success: false, message: "invalid token" }),
  ]);
  assert.equal(result.error, "newapi balance query /api/usage/token/ returned HTTP 401: invalid token");
  assert.ok(!result.error.includes(KEY));
});

test("One API: hard limit minus usage in cents", () => {
  const { sent, result } = query("https://oneapi.example.com", { upstreamKind: "oneapi" }, [
    reply(200, { object: "billing_subscription", hard_limit_usd: 20, soft_limit_usd: 20 }),
    reply(200, { object: "list", total_usage: 1250 }),
  ]);
  assert.equal(sent[1].path, "/v1/dashboard/billing/usage?start_date=2025-09-24&end_date=2026-01-02");
  assert.deepEqual(result, { amount: 7.5, currency: "USD" });

  const unlimited = query("https://oneapi.example.com", { upstreamKind: "oneapi" }, [reply(200, { hard_limit_usd: 100000000 })]);
  assert.deepEqual(unlimited.result, { unlimited: true });

  const cny = query("https://oneapi.example.com", { upstreamKind: "oneapi", currency: "CNY" }, [
    reply(200, { hard_limit_usd: 70 }),
    reply(200, { total_usage: 1000 }),
  ]);
  assert.deepEqual(cny.result, { amount: 60, currency: "CNY" });
});

test("sub2api: remaining, wallet balance, invalid key and unlimited subscription", () => {
  const remaining = query("https://sub2api.example.com", { upstreamKind: "sub2api" }, [reply(200, { balance: 100, remaining: 12.345, isValid: true, unit: "USD" })]);
  assert.deepEqual(remaining.result, { amount: 12.345, currency: "USD" });
  const wallet = query("https://sub2api.example.com", { upstreamKind: "sub2api" }, [reply(200, { balance: 42.5, isValid: true })]);
  assert.deepEqual(wallet.result, { amount: 42.5, currency: "USD" });
  const invalid = query("https://sub2api.example.com", { upstreamKind: "sub2api" }, [reply(200, { isValid: false })]);
  assert.match(invalid.result.error, /invalid/);
  const unlimited = query("https://sub2api.example.com", { upstreamKind: "sub2api" }, [
    reply(200, { remaining: -1, isValid: true, subscription: { daily_limit_usd: null, weekly_limit_usd: null, monthly_limit_usd: null } }),
  ]);
  assert.deepEqual(unlimited.result, { unlimited: true });
});

test("DeepSeek: picks the funded currency, or the configured one", () => {
  const body = { is_available: true, balance_infos: [
    { currency: "USD", total_balance: "0.00", granted_balance: "0.00", topped_up_balance: "0.00" },
    { currency: "CNY", total_balance: "110.50", granted_balance: "10.00", topped_up_balance: "100.50" },
  ] };
  assert.deepEqual(query("https://api.deepseek.com", {}, [reply(200, body)]).result, { amount: 110.5, currency: "CNY" });
  assert.deepEqual(query("https://api.deepseek.com", { currency: "USD" }, [reply(200, body)]).result, { amount: 0, currency: "USD" });
  assert.match(query("https://api.deepseek.com", {}, [reply(200, { balance_infos: [] })]).result.error, /no balance_infos/);
});

test("Moonshot: CNY on moonshot.cn, USD on moonshot.ai", () => {
  const body = { code: 0, data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 }, scode: "0x0", status: true };
  assert.deepEqual(query("https://api.moonshot.cn", {}, [reply(200, body)]).result, { amount: 49.58894, currency: "CNY" });
  assert.deepEqual(query("https://api.moonshot.ai", {}, [reply(200, body)]).result, { amount: 49.58894, currency: "USD" });
  assert.match(query("https://api.moonshot.cn", {}, [reply(200, { code: 5, message: "bad" })]).result.error, /Moonshot balance query failed: bad/);
});

test("SiliconFlow: totalBalance string", () => {
  const body = { code: 20000, message: "OK", status: true, data: { balance: "0.88", chargeBalance: "88.00", totalBalance: "88.88" } };
  assert.deepEqual(query("https://api.siliconflow.cn", {}, [reply(200, body)]).result, { amount: 88.88, currency: "CNY" });
  assert.deepEqual(query("https://api.siliconflow.com", {}, [reply(200, body)]).result, { amount: 88.88, currency: "USD" });
});

test("OpenRouter: key limit first, account credits for a key without a limit", () => {
  const limited = query("https://openrouter.ai/api", {}, [reply(200, { data: { label: "x", limit: 100, limit_remaining: 74.5, usage: 25.5 } })]);
  assert.equal(limited.sent[0].path, "/v1/key");
  assert.deepEqual(limited.result, { amount: 74.5, currency: "USD" });
  const credits = query("https://openrouter.ai/api", {}, [
    reply(200, { data: { limit: null, limit_remaining: null, usage: 3 } }),
    reply(200, { data: { total_credits: 100.5, total_usage: 25.75 } }),
  ]);
  assert.deepEqual(credits.sent.map((s) => s.path), ["/v1/key", "/v1/credits"]);
  assert.deepEqual(credits.result, { amount: 74.75, currency: "USD" });
  const denied = query("https://openrouter.ai/api", {}, [
    reply(200, { data: { limit: null, limit_remaining: null } }),
    reply(403, { error: { message: "management key required" } }),
  ]);
  assert.match(denied.result.error, /set a credit limit on the key/);
});

test("Custom JSON: dotted field over a divisor in the configured currency", () => {
  const config = { upstreamKind: "custom", customPath: "/api/wallet?scope=self", customField: "data.quota", customDivisor: 500000, currency: "CNY" };
  const { sent, result } = query("https://relay.example.com", config, [reply(200, { data: { quota: 1250000 } })]);
  assert.equal(sent[0].path, "/api/wallet?scope=self");
  assert.deepEqual(result, { amount: 2.5, currency: "CNY" });
  assert.match(query("https://relay.example.com", config, [reply(200, { data: {} })]).result.error, /not a number/);
});

test("Auto on an unknown host probes New API, then sub2api, then One API", () => {
  const { sent, result } = query("https://relay.example.com", {}, [
    reply(404, "404 page not found"),
    reply(404, { error: "not found" }),
    reply(200, { hard_limit_usd: 10 }),
    reply(200, { total_usage: 100 }),
  ]);
  assert.deepEqual(sent.map((s) => s.path.split("?")[0]), ["/api/usage/token/", "/v1/usage", "/v1/dashboard/billing/subscription", "/v1/dashboard/billing/usage"]);
  assert.deepEqual(result, { amount: 9, currency: "USD" });

  const newapi = query("https://relay.example.com", {}, [
    reply(200, { code: true, data: { total_available: 1000000 } }),
    reply(200, { data: { quota_per_unit: 500000 } }),
  ]);
  assert.deepEqual(newapi.result, { amount: 2, currency: "USD" });

  const none = query("https://relay.example.com", {}, [reply(404, ""), reply(404, ""), reply(404, "")]);
  assert.match(none.result.error, /Auto could not recognize the upstream/);
});

test("decide: threshold disable, recovery with hysteresis, reasons", () => {
  const s = { disableBelow: 5, enableAtOrAbove: 10, autoDisable: true, reenable: "balance" };
  assert.equal(decide(s, "enabled", undefined, { amount: 4.99, currency: "USD" }).keyStatus, "auto_disabled");
  assert.deepEqual(decide(s, "enabled", undefined, { amount: 5, currency: "USD" }), {});
  assert.deepEqual(decide(s, "enabled", undefined, { unlimited: true }), {});
  assert.deepEqual(decide(s, "auto_disabled", "Upstream balance 1 USD is below", { amount: 9, currency: "USD" }), {});
  assert.equal(decide(s, "auto_disabled", "Upstream balance 1 USD is below", { amount: 10, currency: "USD" }).keyStatus, "enabled");
  assert.equal(decide(s, "auto_disabled", "Insufficient balance", { amount: 12, currency: "USD" }).keyStatus, "enabled");
  assert.deepEqual(decide(s, "auto_disabled", "status code 401", { amount: 12, currency: "USD" }), {});
  assert.equal(decide(Object.assign({}, s, { reenable: "any" }), "auto_disabled", "status code 401", { amount: 12, currency: "USD" }).keyStatus, "enabled");
  assert.deepEqual(decide(Object.assign({}, s, { reenable: "off" }), "auto_disabled", "Insufficient balance", { amount: 12, currency: "USD" }), {});
  assert.deepEqual(decide(Object.assign({}, s, { autoDisable: false }), "enabled", undefined, { amount: 0, currency: "USD" }), {});
  // A zero or negative balance disables even with a zero threshold.
  assert.equal(decide({ disableBelow: 0, enableAtOrAbove: 0, autoDisable: true, reenable: "balance" }, "enabled", undefined, { amount: 0, currency: "CNY" }).keyStatus, "auto_disabled");
});

test("scheduled disables a key below the threshold and reports its balance", () => {
  const out = runScheduled("https://api.deepseek.com", { disableBelow: 20, checkMinutes: 5 }, "enabled", undefined, [
    fetched(200, { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "12.30" }] }),
  ]);
  assert.equal(fetchLog.length, 1);
  assert.equal(fetchLog[0].url, "https://api.deepseek.com/user/balance");
  assert.equal(fetchLog[0].headers.Authorization, "Bearer " + KEY);
  assert.equal(out.next, 300);
  assert.deepEqual(out.balance, { amount: 12.3, currency: "CNY" });
  assert.equal(out.keyStatus, "auto_disabled");
  assert.equal(out.notify.en, "Upstream balance 12.3 CNY is below the threshold 20 CNY; key disabled");
  assert.equal(out.notify.zh, "上游余额 12.3 CNY 低于阈值 20 CNY，已禁用该密钥");
  assert.ok(Buffer.byteLength(JSON.stringify(out.notify)) < 1024);
});

test("scheduled re-enables a key it disabled once the balance recovers", () => {
  const replies = [
    fetched(200, { code: true, data: { total_available: 15000000 } }),
    fetched(200, { data: { quota_per_unit: 500000 } }),
  ];
  const out = runScheduled("http://relay.example.com/", { upstreamKind: "newapi", disableBelow: 20, enableAtOrAbove: 25 }, "auto_disabled",
    "Upstream balance 3 USD is below the threshold 20 USD; key disabled", replies);
  assert.deepEqual(fetchLog.map((f) => f.url), ["http://relay.example.com/api/usage/token/", "http://relay.example.com/api/status"]);
  assert.equal(out.keyStatus, "enabled");
  assert.equal(out.next, 1800);
  assert.match(out.notify.en, /^Upstream balance recovered to 30 USD/);
});

test("scheduled leaves a still-low disabled key alone, without notifying again", () => {
  const out = runScheduled("https://api.moonshot.cn", { disableBelow: 20 }, "auto_disabled", "Upstream balance 3 CNY is below", [
    fetched(200, { code: 0, data: { available_balance: 8 } }),
  ]);
  assert.deepEqual(out, { next: 1800, balance: { amount: 8, currency: "CNY" } });
});

test("scheduled throws on a failed query so the host retries and logs it", () => {
  assert.throws(() => runScheduled("https://api.siliconflow.cn", {}, "enabled", undefined, [fetched(401, { message: "Invalid token" })]),
    /siliconflow balance query \/v1\/user\/info returned HTTP 401: Invalid token/);
});

test("scheduled auto mode stays within four fetches", () => {
  const out = runScheduled("https://relay.example.com", {}, "enabled", undefined, [
    fetched(404, "404 page not found"),
    fetched(404, ""),
    fetched(200, { hard_limit_usd: 3 }),
    fetched(200, { total_usage: 0 }),
  ]);
  assert.equal(fetchLog.length, 4);
  assert.deepEqual(out.balance, { amount: 3, currency: "USD" });
  assert.equal(out.keyStatus, undefined);
});

test("checkKey rejects a key line with spaces", () => {
  assert.equal(checkKey({ baseUrl: "", config: {} }, KEY), undefined);
  assert.deepEqual(checkKey({ baseUrl: "", config: {} }, "sk-a sk-b"), { error: { en: "A key line must not contain spaces", zh: "密钥行不能包含空格" } });
});

test("golden fixture cases match the hooks", () => {
  const golden = JSON.parse(readFileSync(new URL("./golden.json", import.meta.url), "utf8"));
  assert.ok(golden.cases.length >= 8);
  for (const c of golden.cases) {
    if (c.expectedError) {
      assert.throws(() => plugin[c.hook](...c.args), (e) => e.message.includes(c.expectedError), c.name);
      continue;
    }
    const out = plugin[c.hook](...c.args);
    assert.deepEqual(out === undefined ? null : JSON.parse(JSON.stringify(out)), c.expected, c.name);
  }
});
