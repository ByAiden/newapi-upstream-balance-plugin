---
changelogVersion: 1
plugin: byaiden_upstream_balance
version: 1.0.0
locale: "en"
translations:
  zh-CN: CHANGELOG.zh-CN.md
---

# Changelog

## [1.0.0]

### Added

- OpenAI-compatible relay on a type-61 channel for `/v1/chat/completions` (streaming included), `/v1/responses`, `/v1/embeddings`, `/v1/images/generations`, `/v1/rerank` and `/v1/models`, passed through to the upstream unchanged.
- Per-key upstream balance for New API, One API, sub2api, DeepSeek, Moonshot, SiliconFlow, OpenRouter and custom JSON endpoints, in the upstream's own currency, with automatic detection of the upstream kind.
- Timed balance checks that disable a key below a configurable threshold and enable it again once the balance reaches a recovery threshold, with notifications to the channel watchers.
