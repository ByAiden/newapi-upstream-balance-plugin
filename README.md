---
locale: en
translations:
  zh-CN: README.zh-CN.md
---

# Upstream Balance

**English** | [简体中文](README.zh-CN.md)

Relays OpenAI-compatible endpoints to an upstream API on a type-61 channel and watches the upstream balance of every key on it. Supported upstreams: another New API or One API gateway, sub2api, DeepSeek, Moonshot (Kimi), SiliconFlow, OpenRouter, and any endpoint that returns the balance as a JSON number.

- Balance: "Update balance" on the channel, and new-api's "Update all balances", show each key's balance in the upstream's own currency.
- Threshold: on a timer, a key whose balance is below the disable threshold is automatically disabled, with a notification to the channel watchers.
- Recovery: once an automatically disabled key's balance is back at or above the recovery threshold, it is enabled again, without a test request.

Requires new-api v1.0.0-rc.50 or later (provider plugins with the balance and scheduled hooks).

## Compared with the built-in balance feature

new-api already queries balances for some built-in channel types: OpenAI and Custom (`/v1/dashboard/billing/subscription` and `/usage`), New API, sub2api, DeepSeek, Moonshot, SiliconFlow, OpenRouter, AIProxy, API2GPT and AIGC2D. It disables a channel only when the balance is 0 or less, and only during "Update all balances" (by hand, or every `CHANNEL_UPDATE_FREQUENCY` minutes). This plugin adds:

| | Built-in | This plugin |
| --- | --- | --- |
| Disable threshold | 0 only | Any amount, such as 5 USD |
| Re-enable after a top-up | No; only a successful channel test re-enables, when automatic enabling is on | Yes, from the balance, with a separate recovery threshold |
| Multi-key channels | No balance query | Each key queried, disabled and re-enabled on its own |
| Schedule | Needs `CHANNEL_UPDATE_FREQUENCY`, all channels at once | Per channel, every 1 to 1440 minutes |
| Vendor hosts | DeepSeek, Moonshot (`api.moonshot.cn`) and SiliconFlow (`api.siliconflow.cn`) addresses are fixed | The channel Base URL, so `api.moonshot.ai` or a reverse proxy works |
| Currency | Stored as USD | Shown in the upstream currency; the USD column is still filled for USD and CNY |
| OpenRouter | `/credits`, which needs a management key | The key's own `limit_remaining`, then `/credits` |

If an ordinary channel's built-in balance and the 0 threshold are enough, you do not need this plugin.

## Channel setup

1. Install the plugin (key `byaiden_upstream_balance`), then add a channel of type Task Plugin and bind it to this plugin. Existing OpenAI or vendor channels are not affected; create new type-61 channels for the keys you want watched.
2. Base URL: the upstream origin without `/v1`, for example `https://api.deepseek.com`, `https://relay.example.com` or `https://openrouter.ai/api`. Balance paths below are joined to it.
3. Key: the upstream API key, the same `sk-` key used for requests. Put several keys on separate lines for a multi-key channel; each key gets its own balance and status.
4. Models: the upstream model names you want to serve, as on any channel.
5. Turn on automatic disabling for the channel ("auto ban"); without it the plugin reports balances but never disables a key.
6. Channel settings:
   - Upstream kind: Auto (default) picks DeepSeek, Moonshot, SiliconFlow or OpenRouter from the Base URL host, and on other hosts tries the New API, sub2api and One API endpoints in that order. Pick the kind explicitly when you know it.
   - Currency: overrides the detected currency, for example `CNY` for a One API site that displays amounts in CNY.
   - Disable threshold: a key whose balance is below it, or 0 or less, is disabled. Default 0.
   - Recovery threshold: a disabled key is enabled again at or above it. 0 (default) uses the disable threshold. Set it higher to avoid flapping.
   - Disable keys below the threshold: on by default.
   - Re-enable after recovery: "Keys disabled for low balance" (default) restores keys this plugin disabled and keys new-api disabled with "Insufficient balance"; "Any automatically disabled key" also restores keys disabled for request errors once their balance query succeeds; "Never".
   - Check interval in minutes: 30 by default.
   - Custom balance path, field and divisor: for the custom kind only.

Thresholds are in the currency the upstream reports, shown with the channel balance.

## Upstream kinds and balance endpoints

All requests are `GET` with `Authorization: Bearer` and the channel key.

| Kind | Endpoint | Balance | Currency |
| --- | --- | --- | --- |
| New API | `/api/usage/token/`, then `/api/status` | `total_available` (the smaller of the key's and, when the key allows "query user quota", the owner's) divided by `quota_per_unit` | USD |
| One API | `/v1/dashboard/billing/subscription`, then `/v1/dashboard/billing/usage` | `hard_limit_usd` minus `total_usage` / 100; a hard limit of 100000000 is reported as unlimited | USD, or the configured currency |
| sub2api | `/v1/usage` | `remaining`, else `balance`; a subscription without daily, weekly or monthly limits is unlimited | `unit`, USD by default |
| DeepSeek | `/user/balance` | `total_balance` of the configured currency, else the first funded entry | CNY or USD as reported |
| Moonshot | `/v1/users/me/balance` | `available_balance` | USD on `moonshot.ai`, CNY otherwise |
| SiliconFlow | `/v1/user/info` | `totalBalance` | USD on `siliconflow.com`, CNY otherwise |
| OpenRouter | `/v1/key`, then `/v1/credits` | the key's `limit_remaining`; for a key without a limit, `total_credits` minus `total_usage` | USD |
| Custom | the configured path | the configured dot-path field divided by the divisor | USD, or the configured currency |

For a New API upstream, `/api/usage/token/` is used rather than the dashboard endpoints, because the dashboard amounts follow the upstream's display currency setting. An unlimited New API key reports an error until "Allow querying user quota" is turned on for it upstream.

## Models and endpoints

| Client endpoint | Upstream |
| --- | --- |
| `POST /v1/chat/completions` | `/v1/chat/completions`, streaming included |
| `POST /v1/responses` | `/v1/responses` |
| `POST /v1/embeddings` | `/v1/embeddings` |
| `POST /v1/images/generations` | `/v1/images/generations` |
| `POST /v1/rerank` | `/v1/rerank` |
| `GET /v1/models` | `/v1/models`, for the channel's model list |

Requests and replies pass through unchanged. The upstream must speak the OpenAI protocol on these paths.

## Billing

Requests are billed by new-api from the usage in the upstream reply, at the prices you set for each model, as on an ordinary OpenAI-compatible channel. The balance hooks and the timer send no billable requests: they only read balance endpoints.

## Example

```bash
curl https://your-gateway.example/v1/chat/completions \
  -H "Authorization: Bearer YOUR_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model": "deepseek-chat", "messages": [{"role": "user", "content": "Hello"}]}'
```

The channel balance after "Update balance" on a DeepSeek channel:

```json
{"amount": 110.5, "currency": "CNY", "unlimited": false, "windows": []}
```

## Limits

- Timer checks run only on the master node, at most four at a time, and the first check of a key happens at a random time within 10 minutes of the channel appearing or the gateway starting.
- A failed balance query is retried after 15 minutes and recorded in the system log with the channel and key index; it never disables or enables a key.
- Unlimited results never disable a key. new-api itself also disables a key whose balance is 0 or less during "Update all balances".
- Manually disabled channels and keys are never touched.
- Keys only: the plugin does not log in to upstream accounts and does not store access tokens.
- Not covered: Anthropic `/v1/messages`, audio, realtime and other paths; use an ordinary channel for them.
