---
locale: zh-CN
---

# Upstream Balance

[English](README.md) | **简体中文**

在 type-61 渠道上把 OpenAI 兼容接口中转到上游 API，并监控渠道上每个密钥的上游余额。支持的上游：其他 New API 或 One API 网关、sub2api、DeepSeek、Moonshot（Kimi）、硅基流动、OpenRouter，以及任何以 JSON 数字返回余额的接口。

- 余额：渠道的“更新余额”和 new-api 的“更新所有余额”会以上游自己的币种显示每个密钥的余额。
- 阈值：定时检查，余额低于禁用阈值的密钥会被自动禁用，并通知渠道关注者。
- 恢复：被自动禁用的密钥余额回到恢复阈值及以上后会重新启用，无需发送测试请求。

需要 new-api v1.0.0-rc.50 或更高版本（支持余额与定时钩子的提供方插件）。

## 与内置余额功能的区别

new-api 已为部分内置渠道类型查询余额：OpenAI 与自定义（`/v1/dashboard/billing/subscription` 和 `/usage`）、New API、sub2api、DeepSeek、Moonshot、硅基流动、OpenRouter、AIProxy、API2GPT 和 AIGC2D。它只在余额不大于 0 时禁用渠道，且只在“更新所有余额”时（手动，或每 `CHANNEL_UPDATE_FREQUENCY` 分钟）进行。本插件补充：

| | 内置 | 本插件 |
| --- | --- | --- |
| 禁用阈值 | 只有 0 | 任意金额，如 5 USD |
| 充值后重新启用 | 不会；只有开启自动启用时，渠道测试成功才会启用 | 会，按余额判断，且有独立的恢复阈值 |
| 多密钥渠道 | 不支持余额查询 | 每个密钥单独查询、禁用和重新启用 |
| 调度 | 需要 `CHANNEL_UPDATE_FREQUENCY`，所有渠道一起 | 按渠道，每 1 到 1440 分钟 |
| 厂商地址 | DeepSeek、Moonshot（`api.moonshot.cn`）和硅基流动（`api.siliconflow.cn`）地址写死 | 使用渠道 Base URL，`api.moonshot.ai` 或反向代理都可用 |
| 币种 | 存为 USD | 按上游币种显示；USD 与 CNY 仍会填入 USD 列 |
| OpenRouter | `/credits`，需要管理密钥 | 先读密钥自己的 `limit_remaining`，再读 `/credits` |

如果普通渠道的内置余额和 0 阈值已经够用，就不需要本插件。

## 渠道设置

1. 安装插件（key 为 `byaiden_upstream_balance`），新建类型为 Task Plugin 的渠道并绑定本插件。已有的 OpenAI 或厂商渠道不受影响；需要监控的密钥请新建 type-61 渠道。
2. Base URL：不带 `/v1` 的上游地址，如 `https://api.deepseek.com`、`https://relay.example.com` 或 `https://openrouter.ai/api`。下文的余额路径拼接在它后面。
3. 密钥：上游 API 密钥，即请求所用的 `sk-` 密钥。多密钥渠道每行一个；每个密钥有自己的余额和状态。
4. 模型：要提供的上游模型名，与普通渠道相同。
5. 为渠道开启自动禁用；未开启时插件只报告余额，不会禁用密钥。
6. 渠道配置：
   - 上游类型：自动（默认）按 Base URL 域名识别 DeepSeek、Moonshot、硅基流动或 OpenRouter，其他域名依次尝试 New API、sub2api、One API 接口。已知类型时请直接选择。
   - 币种：覆盖自动判断的币种，例如以人民币显示金额的 One API 站点填 `CNY`。
   - 禁用阈值：余额低于该值（或不大于 0）的密钥会被禁用。默认 0。
   - 恢复阈值：被禁用的密钥余额达到该值后重新启用。0（默认）表示与禁用阈值相同。设得更高可避免反复切换。
   - 低于阈值时禁用密钥：默认开启。
   - 恢复后重新启用：“因余额不足被禁用的密钥”（默认）恢复本插件禁用的密钥，以及 new-api 以 “Insufficient balance” 禁用的密钥；“任何被自动禁用的密钥”还会在余额查询成功后恢复因请求错误被禁用的密钥；“从不”。
   - 检查间隔（分钟）：默认 30。
   - 自定义余额路径、字段和除数：仅用于自定义类型。

阈值使用上游报告的币种，即渠道余额旁显示的币种。

## 上游类型与余额接口

所有请求都是 `GET`，带渠道密钥的 `Authorization: Bearer`。

| 类型 | 接口 | 余额 | 币种 |
| --- | --- | --- | --- |
| New API | `/api/usage/token/`，然后 `/api/status` | `total_available`（密钥额度，与密钥允许“查询用户额度”时所属用户额度中的较小者）除以 `quota_per_unit` | USD |
| One API | `/v1/dashboard/billing/subscription`，然后 `/v1/dashboard/billing/usage` | `hard_limit_usd` 减 `total_usage` / 100；硬上限 100000000 视为无限 | USD 或配置的币种 |
| sub2api | `/v1/usage` | `remaining`，否则 `balance`；没有日、周、月限额的订阅视为无限 | `unit`，默认 USD |
| DeepSeek | `/user/balance` | 配置币种的 `total_balance`，否则第一条有余额的记录 | 上游报告的 CNY 或 USD |
| Moonshot | `/v1/users/me/balance` | `available_balance` | `moonshot.ai` 为 USD，其他为 CNY |
| 硅基流动 | `/v1/user/info` | `totalBalance` | `siliconflow.com` 为 USD，其他为 CNY |
| OpenRouter | `/v1/key`，然后 `/v1/credits` | 密钥的 `limit_remaining`；未设限额的密钥用 `total_credits` 减 `total_usage` | USD |
| 自定义 | 配置的路径 | 配置的点号路径字段除以除数 | USD 或配置的币种 |

New API 上游使用 `/api/usage/token/` 而不是 dashboard 接口，因为 dashboard 金额随上游的显示币种设置变化。无限额度的 New API 密钥会报错，直到在上游为它开启“允许查询用户额度”。

## 模型与接口

| 客户端接口 | 上游 |
| --- | --- |
| `POST /v1/chat/completions` | `/v1/chat/completions`，含流式 |
| `POST /v1/responses` | `/v1/responses` |
| `POST /v1/embeddings` | `/v1/embeddings` |
| `POST /v1/images/generations` | `/v1/images/generations` |
| `POST /v1/rerank` | `/v1/rerank` |
| `GET /v1/models` | `/v1/models`，用于渠道模型列表 |

请求与回复原样转发。上游必须在这些路径上使用 OpenAI 协议。

## 计费

请求由 new-api 按上游回复中的用量和你为各模型设置的价格计费，与普通 OpenAI 兼容渠道相同。余额钩子与定时任务不发送计费请求，只读取余额接口。

## 示例

```bash
curl https://your-gateway.example/v1/chat/completions \
  -H "Authorization: Bearer YOUR_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model": "deepseek-chat", "messages": [{"role": "user", "content": "你好"}]}'
```

DeepSeek 渠道“更新余额”后的渠道余额：

```json
{"amount": 110.5, "currency": "CNY", "unlimited": false, "windows": []}
```

## 限制

- 定时检查只在主节点运行，最多同时四个；密钥的首次检查在渠道出现或网关启动后 10 分钟内的随机时间进行。
- 余额查询失败会在 15 分钟后重试，并在系统日志中记录渠道和密钥序号；失败不会禁用或启用密钥。
- 无限额度结果不会禁用密钥。new-api 自身在“更新所有余额”时也会禁用余额不大于 0 的密钥。
- 手动禁用的渠道和密钥不会被改动。
- 仅使用密钥：插件不登录上游账号，也不保存访问令牌。
- 不支持：Anthropic `/v1/messages`、音频、实时等路径；请为它们使用普通渠道。
