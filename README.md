# Xiaoyu · AI Emotional Companion

> **Every feeling deserves to be understood.**

A production web application that gives people a gentle, always-available place to talk about how they
feel — an AI companion, guided self-reflection, and branching story roleplay.

**Live: <https://myxiaoyu.com/>**

**My role:** end-to-end — product design, frontend, backend, AI prompt engineering, data model and
self-hosted deployment.

---

## What it does

| Feature | Notes |
|---|---|
| **Chat** | Multi-session conversations with streaming replies and image understanding |
| **Reflect** | Structured emotion analysis that turns a free-form message into an emotion note plus a short story |
| **Roleplay** | A scenario engine with branching stories, user-created characters and content gating |
| **Long-term memory** | The companion remembers what matters, with time anchors resolved in the user's own timezone |
| **Mood check-in** | Daily mood, streaks, a 30-day calendar and emotion trend curves |
| **Three languages** | Simplified Chinese, Traditional Chinese and English — the UI *and* the AI replies follow the choice |
| **Accounts & quota** | Email sign-up, password recovery, invitations, and a credit-based daily quota |
| **Membership** | Stripe checkout with webhook-driven entitlement unlocks |
| **Admin console** | Order confirmation, user management, funnel, feedback, audit log and API cost reporting |

---

## Engineering highlights

- **Streaming chat over SSE** with a typewriter UI, cancel-on-disconnect and honest failure states.
- **Prompt engineering for a persona**: layered system prompts assembled from a single source of truth,
  with explicit anti-injection boundaries and a rule that system/fallback copy can never be written
  into the message store (so it can never be mistaken for something the character said).
- **Content safety that actually holds**: input is normalised across Simplified/Traditional Chinese
  before matching, and the lexicon covers homophones, split characters, pinyin and English slang.
- **Long-term memory with structure**: every entry carries a time anchor, a kind and a status, and is
  injected together with "now" at minute granularity in the user's timezone.
- **Quota and cost accounting**: every model call is metered, priced with off-peak/peak multipliers and
  attributed back to the user, surfaced to the user as "about N messages left" rather than raw tokens.
- **Storage abstraction**: a single persistence layer with atomic writes, migrated from JSON files to
  SQLite behind one interface.
- **Tests first**: 1,200+ unit and integration tests (`node:test` + tsx) covering quota, safety,
  memory, payments and the API surface, plus headless end-to-end checks in `scripts/verify/`.

---

## Tech stack

- **Frontend** — React 18 · TypeScript · Vite · Tailwind CSS · Zustand · react-router v7
- **Backend** — Node.js · Express · tsx (ESM), single process
- **AI** — DeepSeek (OpenAI-compatible) for chat, roleplay and vision
- **Payments** — Stripe, with webhook-driven entitlement unlocks
- **Data** — SQLite behind a small storage abstraction
- **Deployment** — self-hosted Express behind Cloudflare, with Docker support

---

## Getting started

```bash
npm install
cp env.local.example .env     # or create .env yourself and fill in your keys
npm run dev                   # Vite frontend + nodemon backend on :3001
```

Production build:

```bash
npm run build:seo             # vite build + prerender
npm run start:prod            # Express serves dist/ + public/ on :3001
```

Useful scripts: `npm run check` (type-check) · `npm run lint` · `npm test` (unit + integration).

---

## Repository notes

- **Large media is intentionally excluded** from this repository: font files, background music and the
  interactive-fiction artwork (about 600 MB in total). The application code, API, prompt logic and
  tests are complete — you just won't get the binary art assets.
- **No secrets are committed.** Every credential, price and feature flag is read from the environment.
- Internal operating documents, business planning and marketing material are deliberately not part of
  this public repository.

---

## License

MIT — see [LICENSE](LICENSE).

---

## 简体中文摘要

**小愈（Xiaoyu）** = AI 情绪陪伴网页应用（<https://myxiaoyu.com/>），我独立完成产品设计、前端、后端、
AI 提示词工程与自部署。

- 双模式：**聊一聊**（多会话 + SSE 流式）与**理一理**（结构化情绪分析 → 情绪笔记 + 暖心故事）
- 角色剧情扮演引擎（分支剧情 / 自建角色 / 内容分级），长期记忆（带时间锚、按用户时区）
- 三语言界面与 AI 回复、地区语气、心情打卡、账户与额度、Stripe 会员、运营后台
- 工程要点：单一真源的提示词分层与反注入边界、简繁归一的内容安全词表、按调用计费的成本核算、
  存储抽象（JSON → SQLite）、1,200+ 单元与集成测试 + headless 端到端脚本
- 技术栈：React 18 + TS + Vite + Tailwind + Zustand ／ Express + tsx ／ DeepSeek ／ Stripe ／ SQLite
- 本仓库**不含**大体积媒体资源（字体、BGM、文游美术，共约 600 MB）与内部运营文档；**不提交任何密钥**
