// Upstream Balance: relays OpenAI-compatible endpoints to an upstream API
// (another New API or One API gateway, a sub2api relay, or a vendor such as
// DeepSeek, Moonshot, SiliconFlow or OpenRouter) on a type-61 channel, reports
// each key's upstream balance, and keeps keys in or out of rotation by it.
//
// Balance: buildBalanceRequest/parseBalance run one small state machine that
// the host drives request by request; scheduled() drives the same machine with
// utils.fetch on the master node, every "check interval" minutes per key.
//   - a key whose balance drops below the threshold is automatically disabled
//     (only when automatic disabling is on for the channel);
//   - an automatically disabled key whose balance is back at or above the
//     recovery threshold is enabled again.
// Amounts stay in the upstream's own currency; thresholds use that currency.

export const meta = {
  "apiVersion": 1,
  "key": "byaiden_upstream_balance",
  "name": { "en": "Upstream Balance", "zh": "上游余额监控" },
  "version": "1.0.0",
  "author": { "name": "ByAiden", "url": "https://github.com/ByAiden" },
  "description": {
    "en": "OpenAI-compatible relay that reads upstream balances and disables or restores keys by threshold",
    "zh": "OpenAI 兼容中转，读取上游余额并按阈值禁用或恢复密钥"
  },
  "models": ["gpt-4o-mini"],
  "relay": [
    { "incoming_path": "/v1/chat/completions", "upstream_path": "/v1/chat/completions" },
    { "incoming_path": "/v1/responses", "upstream_path": "/v1/responses" },
    { "incoming_path": "/v1/embeddings", "upstream_path": "/v1/embeddings" },
    { "incoming_path": "/v1/images/generations", "upstream_path": "/v1/images/generations" },
    { "incoming_path": "/v1/rerank", "upstream_path": "/v1/rerank" },
    { "incoming_path": "/v1/models", "upstream_path": "/v1/models" }
  ],
  "channelConfig": {
    "type": "object",
    "properties": {
      "upstreamKind": {
        "type": "string",
        "title": { "en": "Upstream kind", "zh": "上游类型" },
        "description": {
          "en": "How the balance is read; Auto picks by host, then tries New API, sub2api and One API endpoints",
          "zh": "余额读取方式；自动：先按域名判断，再依次尝试 New API、sub2api、One API 接口"
        },
        "enum": ["auto", "newapi", "oneapi", "sub2api", "deepseek", "moonshot", "siliconflow", "openrouter", "custom"],
        "enumTitles": [
          { "en": "Auto", "zh": "自动" },
          { "en": "New API", "zh": "New API" },
          { "en": "One API or OpenAI billing endpoints", "zh": "One API 或 OpenAI 账单接口" },
          { "en": "sub2api", "zh": "sub2api" },
          { "en": "DeepSeek", "zh": "DeepSeek" },
          { "en": "Moonshot (Kimi)", "zh": "Moonshot（Kimi）" },
          { "en": "SiliconFlow", "zh": "硅基流动" },
          { "en": "OpenRouter", "zh": "OpenRouter" },
          { "en": "Custom JSON endpoint", "zh": "自定义 JSON 接口" }
        ],
        "default": "auto"
      },
      "currency": {
        "type": "string",
        "title": { "en": "Currency", "zh": "币种" },
        "description": {
          "en": "Three-letter code that overrides the detected currency, empty to detect",
          "zh": "三位币种代码，覆盖自动判断的币种，留空则自动判断"
        },
        "pattern": "^([A-Z]{3})?$",
        "default": ""
      },
      "disableBelow": {
        "type": "number",
        "title": { "en": "Disable threshold", "zh": "禁用阈值" },
        "description": {
          "en": "A key whose balance is below this amount, or 0 or less, is disabled",
          "zh": "余额低于该值（或不大于 0）的密钥会被禁用"
        },
        "minimum": 0,
        "default": 0
      },
      "enableAtOrAbove": {
        "type": "number",
        "title": { "en": "Recovery threshold", "zh": "恢复阈值" },
        "description": {
          "en": "A disabled key is enabled again once its balance reaches this amount; 0 uses the disable threshold",
          "zh": "被禁用的密钥余额达到该值后重新启用；0 表示与禁用阈值相同"
        },
        "minimum": 0,
        "default": 0
      },
      "autoDisable": {
        "type": "boolean",
        "title": { "en": "Disable keys below the threshold", "zh": "低于阈值时禁用密钥" },
        "default": true
      },
      "reenable": {
        "type": "string",
        "title": { "en": "Re-enable after recovery", "zh": "恢复后重新启用" },
        "enum": ["balance", "any", "off"],
        "enumTitles": [
          { "en": "Keys disabled for low balance", "zh": "因余额不足被禁用的密钥" },
          { "en": "Any automatically disabled key", "zh": "任何被自动禁用的密钥" },
          { "en": "Never", "zh": "从不" }
        ],
        "default": "balance"
      },
      "checkMinutes": {
        "type": "integer",
        "title": { "en": "Check interval in minutes", "zh": "检查间隔（分钟）" },
        "minimum": 1,
        "maximum": 1440,
        "default": 30
      },
      "customPath": {
        "type": "string",
        "title": { "en": "Custom balance path", "zh": "自定义余额路径" },
        "description": {
          "en": "Path on the Base URL answered with JSON",
          "zh": "Base URL 上返回 JSON 的路径"
        },
        "pattern": "^/[^\\s]*$",
        "default": "/v1/dashboard/billing/credit_grants",
        "visibleWhen": { "upstreamKind": "custom" }
      },
      "customField": {
        "type": "string",
        "title": { "en": "Custom balance field", "zh": "自定义余额字段" },
        "description": {
          "en": "Dot path of the balance in the reply, such as data.balance",
          "zh": "回复中余额的点号路径，如 data.balance"
        },
        "pattern": "^[A-Za-z0-9_]+(\\.[A-Za-z0-9_]+)*$",
        "default": "total_available",
        "visibleWhen": { "upstreamKind": "custom" }
      },
      "customDivisor": {
        "type": "number",
        "title": { "en": "Custom balance divisor", "zh": "自定义余额除数" },
        "description": {
          "en": "The field value is divided by it, such as 500000 for New API quota",
          "zh": "字段值除以该数，如 New API 额度用 500000"
        },
        "minimum": 0.000001,
        "default": 1,
        "visibleWhen": { "upstreamKind": "custom" }
      }
    }
  },
  "keyHint": {
    "en": "Upstream API key, one per line for several keys",
    "zh": "上游 API 密钥，多个密钥每行一个"
  }
};

const KINDS = ["newapi", "oneapi", "sub2api", "deepseek", "moonshot", "siliconflow", "openrouter", "custom"];
// Auto mode probes these in order on hosts it does not recognize.
const PROBES = ["newapi", "sub2api", "oneapi"];
const UNLIMITED_USD = 100000000; // One API / New API report this hard limit for an unlimited key
const OWN_REASON = "Upstream balance";
const HOST_REASON = "Insufficient balance";

function settings(config) {
  const c = config && typeof config === "object" ? config : {};
  const num = (v, d) => (typeof v === "number" && isFinite(v) ? v : d);
  const disableBelow = Math.max(0, num(c.disableBelow, 0));
  const enable = Math.max(0, num(c.enableAtOrAbove, 0));
  return {
    kind: KINDS.indexOf(c.upstreamKind) >= 0 ? c.upstreamKind : "auto",
    currency: typeof c.currency === "string" && /^[A-Z]{3}$/.test(c.currency) ? c.currency : "",
    disableBelow: disableBelow,
    enableAtOrAbove: enable > 0 ? Math.max(enable, disableBelow) : disableBelow,
    autoDisable: c.autoDisable !== false,
    reenable: c.reenable === "any" || c.reenable === "off" ? c.reenable : "balance",
    checkMinutes: Math.min(1440, Math.max(1, Math.round(num(c.checkMinutes, 30)))),
    customPath: typeof c.customPath === "string" && c.customPath.charAt(0) === "/" ? c.customPath : "/v1/dashboard/billing/credit_grants",
    customField: typeof c.customField === "string" && c.customField ? c.customField : "total_available",
    customDivisor: num(c.customDivisor, 1) > 0 ? num(c.customDivisor, 1) : 1,
  };
}

function hostOf(baseUrl) {
  const m = /^[a-z]+:\/\/([^/:?#]+)/i.exec(String(baseUrl || ""));
  return m ? m[1].toLowerCase() : "";
}

function endsWithHost(host, suffix) {
  return host === suffix || host.slice(-(suffix.length + 1)) === "." + suffix;
}

// Known vendor hosts pick their kind; other hosts are probed.
export function detectKind(baseUrl) {
  const host = hostOf(baseUrl);
  if (endsWithHost(host, "deepseek.com")) return "deepseek";
  if (endsWithHost(host, "moonshot.cn") || endsWithHost(host, "moonshot.ai")) return "moonshot";
  if (endsWithHost(host, "siliconflow.cn") || endsWithHost(host, "siliconflow.com")) return "siliconflow";
  if (endsWithHost(host, "openrouter.ai")) return "openrouter";
  return "";
}

function ymd(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function nowSeconds() {
  return typeof utils !== "undefined" && utils && typeof utils.unixNow === "function" ? utils.unixNow() : Math.floor(Date.now() / 1000);
}

function firstRequest(kind, s) {
  switch (kind) {
    case "newapi": return { path: "/api/usage/token/" };
    case "oneapi": return { path: "/v1/dashboard/billing/subscription" };
    case "sub2api": return { path: "/v1/usage" };
    case "deepseek": return { path: "/user/balance" };
    case "moonshot": return { path: "/v1/users/me/balance" };
    case "siliconflow": return { path: "/v1/user/info" };
    case "openrouter": return { path: "/v1/key" };
    default: return { path: s.customPath };
  }
}

function withAuth(request, apiKey) {
  return {
    method: "GET",
    path: request.path,
    headers: { "Authorization": "Bearer " + apiKey, "Accept": "application/json" },
  };
}

function parseBody(response) {
  if (response.body !== null && typeof response.body === "object") return response.body;
  if (typeof response.body !== "string" || response.body === "") return null;
  try {
    return JSON.parse(response.body);
  } catch (e) {
    return null;
  }
}

function ok(response) {
  return response.status >= 200 && response.status < 300;
}

function toNumber(value) {
  if (typeof value === "number") return isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "" && isFinite(Number(value))) return Number(value);
  return null;
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

function upstreamMessage(body) {
  if (!body || typeof body !== "object") return "";
  const e = body.error;
  const text = (e && typeof e === "object" ? e.message : e) || body.message || body.msg || "";
  return typeof text === "string" ? text.slice(0, 200) : "";
}

function httpError(kind, path, response, body) {
  const msg = upstreamMessage(body);
  return { error: kind + " balance query " + path + " returned HTTP " + response.status + (msg ? ": " + msg : "") };
}

function money(amount, currency, s) {
  return { amount: round(amount), currency: s.currency || currency };
}

// start returns the first request and the state that goes with it.
export function startBalance(ctx) {
  const s = settings(ctx.config);
  let kind = s.kind;
  let probes = null;
  if (kind === "auto") {
    kind = detectKind(ctx.baseUrl);
    if (!kind) {
      probes = PROBES.slice(1);
      kind = PROBES[0];
    }
  }
  const req = firstRequest(kind, s);
  return { request: withAuth(req, ctx.apiKey), state: { kind: kind, step: 0, probes: probes } };
}

// advance reads one response: a balance, an error, or the next request.
export function advanceBalance(ctx, state, response) {
  const s = settings(ctx.config);
  const st = state && typeof state === "object" ? state : { kind: s.kind === "auto" ? "newapi" : s.kind, step: 0, probes: null };
  const body = parseBody(response);
  const result = readStep(st, s, ctx, response, body);
  if (result.probeNext && st.probes && st.probes.length > 0) {
    const kind = st.probes[0];
    return { request: withAuth(firstRequest(kind, s), ctx.apiKey), state: { kind: kind, step: 0, probes: st.probes.slice(1) } };
  }
  if (result.probeNext) {
    if (st.probes) return { error: "Auto could not recognize the upstream: no New API, sub2api or One API balance endpoint answered; pick the upstream kind in the channel settings" };
    return result.error ? { error: result.error } : httpError(st.kind, firstRequest(st.kind, s).path, response, body);
  }
  if (result.next) {
    return { request: withAuth(result.next, ctx.apiKey), state: Object.assign({}, st, { step: st.step + 1, probes: null }, result.carry || {}) };
  }
  return result;
}

function readStep(st, s, ctx, response, body) {
  const probing = Array.isArray(st.probes);
  switch (st.kind) {
    case "newapi": return readNewAPI(st, s, response, body, probing);
    case "oneapi": return readOneAPI(st, s, response, body, probing);
    case "sub2api": return readSub2API(s, response, body, probing);
    case "deepseek": return readDeepSeek(s, response, body);
    case "moonshot": return readMoonshot(s, ctx, response, body);
    case "siliconflow": return readSiliconFlow(s, ctx, response, body);
    case "openrouter": return readOpenRouter(st, s, response, body);
    default: return readCustom(s, response, body);
  }
}

// New API: /api/usage/token/ gives the key's remaining quota (and its owner's,
// when the key allows it); /api/status gives quota_per_unit to convert to USD.
function readNewAPI(st, s, response, body, probing) {
  if (st.step === 0) {
    const data = body && body.code === true && body.data && typeof body.data === "object" ? body.data : null;
    if (!ok(response) || !data || toNumber(data.total_available) === null) {
      if (probing) return { probeNext: true };
      if (ok(response)) return { error: "New API usage query failed" + (body && body.message ? ": " + String(body.message).slice(0, 200) : "") };
      return httpError("newapi", "/api/usage/token/", response, body);
    }
    let remaining = data.unlimited_quota === true ? Infinity : toNumber(data.total_available);
    const user = data.user_quota && typeof data.user_quota === "object" ? toNumber(data.user_quota.total_available) : null;
    if (user !== null) remaining = Math.min(remaining, user);
    if (remaining === Infinity) {
      return { error: "The upstream key has unlimited quota; turn on \"Allow querying user quota\" for this key on the upstream to see the account balance" };
    }
    return { next: { path: "/api/status" }, carry: { quota: remaining } };
  }
  const per = body && body.data && typeof body.data === "object" ? toNumber(body.data.quota_per_unit) : null;
  if (!ok(response) || per === null || per <= 0) {
    return ok(response) ? { error: "New API /api/status reply has no quota_per_unit" } : httpError("newapi", "/api/status", response, body);
  }
  return money(st.quota / per, "USD", s);
}

// One API, New API and other OpenAI-style gateways: hard limit minus usage.
function readOneAPI(st, s, response, body, probing) {
  if (st.step === 0) {
    const hard = body && typeof body === "object" ? toNumber(body.hard_limit_usd) : null;
    if (!ok(response) || hard === null) {
      if (probing) return { probeNext: true };
      return ok(response) ? { error: "Billing subscription reply has no hard_limit_usd" } : httpError("oneapi", "/v1/dashboard/billing/subscription", response, body);
    }
    if (hard >= UNLIMITED_USD) return { unlimited: true };
    const now = nowSeconds();
    const path = "/v1/dashboard/billing/usage?start_date=" + ymd(now - 99 * 86400) + "&end_date=" + ymd(now + 86400);
    return { next: { path: path }, carry: { hard: hard } };
  }
  const used = body && typeof body === "object" ? toNumber(body.total_usage) : null;
  if (!ok(response) || used === null) {
    return ok(response) ? { error: "Billing usage reply has no total_usage" } : httpError("oneapi", "/v1/dashboard/billing/usage", response, body);
  }
  return money(st.hard - used / 100, "USD", s);
}

// sub2api: /v1/usage reports remaining (or balance) in its unit.
function readSub2API(s, response, body, probing) {
  const shaped = body && typeof body === "object" && ("isValid" in body || "remaining" in body || "balance" in body);
  if (!ok(response) || !shaped) {
    if (probing) return { probeNext: true };
    return ok(response) ? { error: "sub2api /v1/usage reply has no balance" } : httpError("sub2api", "/v1/usage", response, body);
  }
  if (body.isValid === false) return { error: "sub2api reports the key as invalid (isValid=false)" };
  const sub = body.subscription && typeof body.subscription === "object" ? body.subscription : null;
  if (sub && sub.daily_limit_usd == null && sub.weekly_limit_usd == null && sub.monthly_limit_usd == null) {
    return { unlimited: true };
  }
  let amount = toNumber(body.remaining);
  if (amount === null) amount = toNumber(body.balance);
  if (amount === null) return { error: "sub2api /v1/usage reply has neither remaining nor balance" };
  const unit = typeof body.unit === "string" && /^[A-Za-z]{3}$/.test(body.unit) ? body.unit.toUpperCase() : "USD";
  return money(amount, unit, s);
}

// DeepSeek: balance_infos per currency, amounts as strings.
function readDeepSeek(s, response, body) {
  if (!ok(response)) return httpError("deepseek", "/user/balance", response, body);
  const infos = body && Array.isArray(body.balance_infos) ? body.balance_infos : [];
  const rows = infos
    .map((r) => ({ currency: String((r && r.currency) || "").toUpperCase(), amount: toNumber(r && r.total_balance) }))
    .filter((r) => /^[A-Z]{3}$/.test(r.currency) && r.amount !== null);
  if (rows.length === 0) return { error: "DeepSeek reply has no balance_infos" };
  let row = s.currency ? rows.find((r) => r.currency === s.currency) : null;
  if (!row) row = rows.find((r) => r.amount > 0) || rows[0];
  return { amount: round(row.amount), currency: row.currency };
}

// Moonshot: available_balance, CNY on moonshot.cn and USD on moonshot.ai.
function readMoonshot(s, ctx, response, body) {
  if (!ok(response)) return httpError("moonshot", "/v1/users/me/balance", response, body);
  const amount = body && body.data && typeof body.data === "object" ? toNumber(body.data.available_balance) : null;
  if (amount === null || (body.code !== undefined && body.code !== 0)) {
    return { error: "Moonshot balance query failed" + (upstreamMessage(body) ? ": " + upstreamMessage(body) : "") };
  }
  return money(amount, endsWithHost(hostOf(ctx.baseUrl), "moonshot.ai") ? "USD" : "CNY", s);
}

// SiliconFlow: data.totalBalance as a string, code 20000 on success.
function readSiliconFlow(s, ctx, response, body) {
  if (!ok(response)) return httpError("siliconflow", "/v1/user/info", response, body);
  const data = body && body.data && typeof body.data === "object" ? body.data : null;
  let amount = data ? toNumber(data.totalBalance) : null;
  if (amount === null && data) amount = toNumber(data.balance);
  if (amount === null || (body.code !== undefined && body.code !== 20000)) {
    return { error: "SiliconFlow balance query failed" + (upstreamMessage(body) ? ": " + upstreamMessage(body) : "") };
  }
  return money(amount, endsWithHost(hostOf(ctx.baseUrl), "siliconflow.com") ? "USD" : "CNY", s);
}

// OpenRouter: /v1/key gives the key's own limit_remaining; a key without a
// limit falls back to the account credits, which need a management key.
function readOpenRouter(st, s, response, body) {
  if (st.step === 0) {
    if (!ok(response)) return httpError("openrouter", "/v1/key", response, body);
    const data = body && body.data && typeof body.data === "object" ? body.data : null;
    if (!data) return { error: "OpenRouter /v1/key reply has no data" };
    const left = toNumber(data.limit_remaining);
    if (left !== null) return money(left, "USD", s);
    return { next: { path: "/v1/credits" } };
  }
  const data = body && body.data && typeof body.data === "object" ? body.data : null;
  const total = data ? toNumber(data.total_credits) : null;
  const used = data ? toNumber(data.total_usage) : null;
  if (!ok(response) || total === null || used === null) {
    return { error: "OpenRouter key has no credit limit and /v1/credits did not answer (HTTP " + response.status + "); set a credit limit on the key to monitor it" };
  }
  return money(total - used, "USD", s);
}

function readCustom(s, response, body) {
  if (!ok(response)) return httpError("custom", s.customPath, response, body);
  let value = body;
  for (const part of s.customField.split(".")) {
    value = value !== null && typeof value === "object" ? value[part] : undefined;
  }
  const amount = toNumber(value);
  if (amount === null) return { error: "Custom balance field " + s.customField + " is not a number" };
  return money(amount / s.customDivisor, "USD", s);
}

function requireKey(ctx) {
  if (!ctx || typeof ctx.apiKey !== "string" || ctx.apiKey.trim() === "") {
    return { error: "The channel key is empty; this plugin reads the balance with a static upstream key" };
  }
  return null;
}

export function buildBalanceRequest(ctx) {
  const missing = requireKey(ctx);
  if (missing) throw new Error(missing.error);
  const first = startBalance(ctx);
  return Object.assign({}, first.request, { state: first.state });
}

export function parseBalance(ctx, response) {
  const out = advanceBalance(ctx, ctx.state, response);
  if (out.request) return { next: out.request, state: out.state };
  return out;
}

// Runs the balance machine with utils.fetch (at most 4 requests per hook).
export function fetchBalance(ctx) {
  const missing = requireKey(ctx);
  if (missing) return missing;
  const base = String(ctx.baseUrl || "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) return { error: "The channel Base URL is empty" };
  let step = startBalance(ctx);
  for (let i = 0; i < 4; i++) {
    const req = step.request;
    const response = utils.fetch({ url: base + req.path, method: "GET", headers: req.headers });
    const out = advanceBalance(ctx, step.state, response);
    if (!out.request) return out;
    step = out;
  }
  return { error: "Balance query needed more than 4 requests" };
}

function fmt(n) {
  return String(round(n));
}

// Decides the key status from a balance. Pure, for tests.
export function decide(s, keyStatus, disabledReason, balance) {
  if (!balance || typeof balance.amount !== "number") return {};
  const amount = balance.amount;
  const cur = balance.currency || "";
  const low = amount <= 0 || amount < s.disableBelow;
  if (keyStatus === "enabled" && low && s.autoDisable) {
    return {
      keyStatus: "auto_disabled",
      notify: {
        en: OWN_REASON + " " + fmt(amount) + " " + cur + " is below the threshold " + fmt(s.disableBelow) + " " + cur + "; key disabled",
        zh: "上游余额 " + fmt(amount) + " " + cur + " 低于阈值 " + fmt(s.disableBelow) + " " + cur + "，已禁用该密钥",
      },
    };
  }
  if (keyStatus === "auto_disabled" && s.reenable !== "off" && amount > 0 && amount >= s.enableAtOrAbove) {
    const reason = String(disabledReason || "");
    const lowBalanceReason = reason.indexOf(OWN_REASON) === 0 || reason.indexOf(HOST_REASON) === 0;
    if (s.reenable === "any" || lowBalanceReason) {
      return {
        keyStatus: "enabled",
        notify: {
          en: OWN_REASON + " recovered to " + fmt(amount) + " " + cur + "; key enabled again",
          zh: "上游余额已恢复到 " + fmt(amount) + " " + cur + "，已重新启用该密钥",
        },
      };
    }
  }
  return {};
}

export function scheduled(ctx) {
  const s = settings(ctx.config);
  const next = s.checkMinutes * 60;
  if (ctx.credential) return { next: next };
  const balance = fetchBalance(ctx);
  if (balance.error) {
    // A throw makes the host log the failure for this channel and key and retry in 15 minutes.
    throw new Error(balance.error);
  }
  const result = { next: next, balance: balance };
  return Object.assign(result, decide(s, ctx.keyStatus, ctx.disabledReason, balance));
}

export function checkKey(ctx, key) {
  if (/\s/.test(String(key).trim())) {
    return { error: { en: "A key line must not contain spaces", zh: "密钥行不能包含空格" } };
  }
}
