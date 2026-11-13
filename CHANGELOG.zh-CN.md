---
changelogVersion: 1
plugin: byaiden_upstream_balance
version: 1.0.0
locale: "zh-CN"
---

# Changelog

## [1.0.0]

### Added

- 在 type-61 渠道上提供 OpenAI 兼容中转：`/v1/chat/completions`（含流式）、`/v1/responses`、`/v1/embeddings`、`/v1/images/generations`、`/v1/rerank` 和 `/v1/models`，原样转发到上游。
- 按密钥读取上游余额，支持 New API、One API、sub2api、DeepSeek、Moonshot、硅基流动、OpenRouter 和自定义 JSON 接口，使用上游自己的币种，并可自动识别上游类型。
- 定时检查余额：余额低于可配置阈值时禁用密钥，余额达到恢复阈值后重新启用，并通知渠道关注者。
