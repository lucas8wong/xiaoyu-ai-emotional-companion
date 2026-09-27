# AI Werewolf · Porting Ledger (wolfcha → Xiaoyu)

> Bilingual with **English first**; the Chinese original below is the source of record and is preserved verbatim under [中文原文](#zh).
> Strategy (decided by the user): **first port wolfcha into the repository wholesale, then adapt it file by file into our own version.**
> Source and licence: `src/werewolf/upstream/ATTRIBUTION.md` (Apache-2.0 · commit `78b4a58c6624fac16d78c17b1fdd2a199076d41e` · no NOTICE upstream · its trademarks are not used)

## 0. Why not "just copy the files"

It is not a moral concern (Apache-2.0 permits it) — it is a **structural conflict**:

| | wolfcha | Xiaoyu |
|---|---|---|
| App shell | Next.js 16 App Router + pnpm workspace + Supabase + Vercel | Vite + React 18 + Express/tsx + our own accounts/sqlite + Cloudflare |
| **Where the match truth lives** | **jotai atom + localStorage (client-authoritative)** | **server-authoritative** (`api/services/werewolf.ts`) |
| State-machine shape | `GamePhase` class inheritance + `PhaseManager` | pure functions `tickOnce` / `runSystemSteps` / `actorsNeeded` |
| Billing | tokenpay / Watcha (Korea) | our own `quota.ts` (credit ledger) |
| Auth | Supabase | our own `accounts.ts` |

Bringing its `store/game-machine.ts` (1143 lines) in as-is = moving the source of truth into the browser, which would directly destroy three things: **perspective isolation, credit settlement and operator-side statistics**. So the porting method is:

> **Vendor the complete source into `vendor/wolfcha/` (4.7M / 350 files) as the reference → port functionality file by file → give every ported item a unit test.**

`vendor/wolfcha/` is not in `tsconfig.include` (only `src`/`api`) or the Tailwind content list, so it **does not enter the build**.
To fetch it again: `git clone --depth 1 https://github.com/oil-oil/wolfcha.git vendor/wolfcha` (then you may delete `.git assets public`).

## 1. The complete vendored source

```
vendor/wolfcha/
├─ LICENSE              ← Apache-2.0 text (kept with the source, a licence requirement)
├─ src/                 ← 271 files / 3.7M: app(Next) components game hooks i18n lib store types
├─ server/              ← its backend contract (tokenpay etc., reference only)
├─ supabase/            ← DB schema (reference for its data structures only)
├─ docs/ scripts/       ← docs and scripts
└─ package.json / next.config.ts / tsconfig.json
```

## 2. Scale of the related code (why it must be incremental)

| Area | Lines | Notes |
|---|---|---|
| `src/game/phases/*` | **1968** | NightPhase 713 / DaySpeechPhase 504 / VotePhase 453 / BadgePhase 149 / HunterPhase 86 / WhiteWolfKingBoom 63 |
| `src/store/game-machine.ts` | 1143 | Client state machine (we only borrow its "phase list") |
| `src/hooks/*` | 5727 | of which `useGameLogic` 2357, `game-phases/useBadgePhase` 699 (behaviour reference for the badge flow) |
| `src/lib/game-master.ts` | 2036 | "Judge" orchestration + prompts |
| `src/lib/game-analysis.ts` | 1788 | Match analysis / review |
| `src/lib/prompt-utils.ts` | 1132 | Prompt enhancement |
| `src/lib/llm.ts` | 1115 | Multi-provider client (⛔ we use `deepseek.ts`) |
| `src/lib/character-generator.ts` | 752 | AI-generated character personas |
| `src/types/game.ts` | 404 | Types for roles/phases/models etc. |
| Other small modules | ~600 | speech-order / vote-rounds / night-visibility / llm-json / deepseek-prompt-scope etc. |

> The logic related to this gameplay totals **≈ 14k lines**. That is the real size of "port it wholesale", and the reason we advance file by file with a test per item.

## 3. File-by-file status

Legend: ✅ ported and verified | 🟡 partially ported | ⬜ not started | ⛔ not porting (reason given)

### 3.1 Game rules / phases

| wolfcha file | Lines | Status | Notes |
|---|---|---|---|
| `src/lib/role-configuration.ts` | 13 | ✅ | 8–12 player compositions (including White Wolf King / Guard / Idiot) are already in the `ROSTERS` of `engine/types.ts`; our 6-player quick game is kept separately |
| `src/lib/vote-rounds.ts` | 10 | ✅ | "Votes before resolution do not enter others' context" → `applyVote` does not reveal + `resolveVote` writes them in at resolution |
| `src/lib/night-visibility.ts` | 13 | ✅ | "resolving ≠ announcing" → event `audience` mechanism + `resolveNight` |
| `src/game/phases/NightPhase.ts` | 713 | 🟡 | Ported: Guard→Wolf→Witch→Seer→resolution, Guard cannot protect consecutively, same-night protect+save kills. To verify: the remaining night-phase edge cases |
| `src/game/phases/HunterPhase.ts` | 86 | ✅ | Equivalent implementation (poisoned cannot shoot, chain determination) |
| `src/game/phases/WhiteWolfKingBoomPhase.ts` | 63 | ✅ | Self-destruct → takes someone with them → night falls that same day |
| `src/game/phases/VotePhase.ts` | 453 | 🟡 | Ported: voting, PK tie-break, Idiot reveal. To verify: sheriff's 1.5 votes |
| `src/game/phases/DaySpeechPhase.ts` | 504 | 🟡 | Ported: sequential speeches, White Wolf King self-destructs while speaking. To verify: sheriff sets the speech order |
| **`src/game/phases/BadgePhase.ts`** | **149** | ⬜ | **Badge flow: in progress this round** (types added, rules not implemented) |
| `src/lib/hunter-badge-flow.ts` | 25 | ⬜ | Hunter + badge interaction |
| `src/lib/historical-vote-snapshots.ts` | 40 | ⬜ | Historical vote snapshots (for review / context) |
| `src/lib/speech-order.ts` | 228 | 🟡 | We have `speakOrder`/`speakIndex`; its finer-grained "skipped/not-yet-spoken" state is more complete; to compare |
| `src/lib/game-constants.ts` / `game-texts.ts` / `scenarios.ts` | 351 | ⬜ | Constants and copy; values to compare |
| `src/game/core/*.ts` | 91 | ⛔ | Class-inheritance phase management; replaced by our equivalent `tickOnce`/`actorsNeeded` |
| `src/store/game-machine.ts` | 1143 | ⛔ | Client-authoritative, conflicts with server authority (we only borrow the phase list) |

### 3.2 AI / prompts

| wolfcha file | Lines | Status | Notes |
|---|---|---|---|
| **`src/lib/deepseek-prompt-scope.ts`** | **39** | ⬜ | **A real gap**: a stable prefix for DeepSeek prefix caching (we measured `prompt_cache_hit_tokens: 0`) |
| `src/lib/game-master.ts` | 2036 | 🟡 | We have built our own `ai/prompt.ts` + orchestration; this serves as a reference for the "judge flow + prompts" |
| `src/lib/prompt-utils.ts` | 1132 | ⬜ | Prompt assembly enhancements (cached message construction etc.) |
| `src/lib/llm-json.ts` | 86 | 🟡 | We have `parseDecision`/`extractJsonObject`; it hooks up `ai-json-fixer`; to evaluate whether it is worth adopting |
| `src/lib/ai-config.ts` | 49 | ⬜ | Parameters such as temperature |
| `src/lib/streaming-speech-parser.ts` | 200 | ⬜ | Streaming speech parsing (with SSE) |
| `src/lib/character-generator.ts` | 752 | ⬜ | AI-generated character personas (we have "Chat" characters, low priority) |
| `src/lib/llm.ts` | 1115 | ⛔ | Multi-provider + key management; we use our `api/services/deepseek.ts` |

### 3.3 Around the match

| wolfcha file | Lines | Status | Notes |
|---|---|---|---|
| `src/lib/game-analysis.ts` | 1788 | 🟡 | Our review card is a subset of it; to compare and add "key-round analysis" |
| `src/hooks/game-phases/useBadgePhase.ts` etc. | ~1000 | 🟡 | **Behaviour reference** for the badge flow / daytime flow (we move it server-side) |
| `src/hooks/useGameLogic.ts` | 2357 | ⛔ | Client orchestration; ours lives in `api/services/werewolf.ts` |
| `src/hooks/useCredits.ts` / `useTokenPay.ts` | 961 | ⛔ | Billing uses our own `quota.ts` |
| `src/types/game.ts` | 404 | 🟡 | Role/phase enums ported; `ModelRef`/multi-model not ported |
| `src/types/analysis.ts` | 149 | ⬜ | Analysis data structures (for review enhancement) |
| `src/app/*`, `src/components/*` | — | 🟡 | Next.js App Router + Radix, **components are not ported**; instead **redrawn from its design tokens** (see §5 below) |
| tokenpay / watcha / supabase / referral / welfare | — | ⛔ | As the user requested: keys and login use our own |

## 5. Visual layer: retro dark theme (the user chose B on 2026-09-15)

**The approach is to reproduce the design tokens, not to port components and not to eyeball-tune from screenshots.**

Source: the variable table in wolfcha's `src/app/globals.css` (vendored, can be inspected locally):

| Purpose | Upstream variable | Value |
|---|---|---|
| Aged gold (primary / CTA) | `--color-gold` / `--color-accent` | `#c5a059` (light `#d4b06a` / dark `#8c7335`) |
| Blood red (wolf faction / warning) | `--color-blood` | `#8a1c1c` (light `#b93636`) |
| Parchment (body text) | `--paper` | `#f0e6d2` |
| Night background | `--bg-night-from/via/to` | `#1a1614 → #14100e → #0d0a08` |
| Card surface | `--bg-dark` | `#1a1614` |
| Muted text | `--text-muted` | `#9c8570` |
| Gold border | `--border-color` | `rgba(140,115,53,0.25~0.38)` |
| Fonts | `--font-title` / `--font-chinese` | Cinzel / Noto Serif SC |
| Role colours | `--color-wolf/seer/witch/hunter/guard/villager` | `#8a1c1c / #2c5282 / #6b46c1 / #c05621 / #276749 / #5c4a3d` |

**How it is implemented** (fitting the project's own architecture): the project's Tailwind colours **all reference CSS variables**, and there is already an `<html data-skin>` theming mechanism.
So we add `src/werewolf/theme.css` and simply **re-map this set of variables** inside the `.ww-theme` scope — not one existing component class name has to change.

- The theme CSS loads lazily as a **separate chunk** with the Werewolf page (`WerewolfPage-*.css` 1.12 kB), with **zero impact on the site-wide brand colours**
- `bg-white` → `bg-clay-surface` (a new `surface` token), to avoid a bright white card on a dark background
- Fonts: `--skin-display-font` uses `Cinzel, 'Ma Shan Zheng', 'Songti SC', serif` —
  Cinzel is not self-hosted, so we use the **project's existing calligraphic font Ma Shan Zheng** to carry the "ancient" feel, without pulling in new font assets

> ⚠️ **The relaxation of brand red line #4 is limited to the `.ww-theme` scope (the Werewolf screen)**; site-wide brand colours (primary green #1FA46B / cream background #FBF6EE) do not change.
> This is the choice the user explicitly made (A align features and keep the brand / **B redraw it from upstream** / C hybrid → chose B).


## 4. Next steps in order (by value)

1. **Badge flow** (`BadgePhase.ts` 149 lines + `useBadgePhase.ts` 699-line reference): running for sheriff → campaign speeches → vote for sheriff → sheriff eliminated hands over the badge; sheriff's 1.5 votes, sets the speech order
2. **DeepSeek prefix caching** (`deepseek-prompt-scope.ts` 39 lines): directly cuts cost, and we have measured that it does not hit
3. Sheriff's 1.5 votes + setting the speech order wired into the existing voting/speech
4. 8/10/11-player games on real devices for the front end (the configuration is already in the engine with unit tests; the UI is unverified)
5. Streaming speeches (SSE) + `streaming-speech-parser`
6. Review enhancement (`game-analysis`), AI-generated personas, voice/spectating
7. **Visual layer**: its retro dark theme conflicts with the project's brand-colour red line (#1FA46B / #FBF6EE), so it needs a product decision before being touched


---

## 6. 2026-09-16 major fix: seven "bugs that look like someone else's but are actually caused by us"

This round traced three things to the bottom — "Get ready takes ages", "refresh loses the match", "no voice" — and the conclusion was highly consistent:
**the symptoms are in the upstream code, but the root cause is our own porting layer.** Recorded here so that later hands do not re-walk it.

| Symptom | Real cause | Fixed where |
|---|---|---|
| Refreshing the page loses the match (back to the signature page) | Our `gameSessionTracker` stub **has every method return the same object**, while `start()`'s return value is **used directly as the `gameSessionId`** stored in the match state; `hasGameSessionId()` requires it to be `typeof === 'string'` → every save decides "unrecoverable" → **actively deletes the save** | `src/wolfcha/lib/game-session-tracker.ts`: `start()` returns a string id |
| "Side voice" never plays | **It is not broken**: upstream calls `setAiVoiceEnabled(false)` in two places, `onStart` and `GAME_END`, **persisting** false into local settings → the next match still reads false | `src/wolfcha/app/page.tsx`: remove those two calls |
| Mobile modal pushed off-screen (left edge -172px) | The same `translate-x-[-50%]` is **generated once by each of two Tailwinds** (our v3 also scans `src/wolfcha` → `transform`; v4 → the `translate` property), so centring happens twice | `tailwind.config.js` excludes `src/wolfcha` from v3 `content` + `public/wolfcha-overrides.css` pins it to one implementation |
| **Our** brand green appears in its UI | Our tokens are defined in `:root`, while its names are `--bg-*` and it does **not define** names like `--color-ring` → component references fall through to our primary green | In `public/wolfcha-overrides.css`, the `.ww-scope` scope maps back to the upstream palette |
| Custom characters forever 0/20 | Upstream stores them in **Supabase**, and Xiaoyu does not use Supabase (stubbed out) → all reads and writes fall through (**dead feature**) | Rewrite the data layer of `src/wolfcha/hooks/useCustomCharacters.ts`: hook up `/api/analysis/chat/characters` + local persistence |
| "Get ready" takes 36 seconds at match start | The batches run **in parallel** under `Promise.allSettled` → **the wall clock is set by the slowest batch, not by the number of batches**. 3 people per batch writes ~3300 tokens per batch → 19–22s per batch | `CHARACTER_PERSONA_BATCH_SIZE` **3 → 1** + forcing `reasoning_effort: 'none'`, **stable at 22.8s / 23.8s across two runs** |
| Stamp "clicked with no response" | Three gates stacked: ① the button is `disabled` to express "the name is empty" (**giving no feedback at all**) ② `canConfirm` depends on `creditsLoading` (initial value true and not cleared when there is no user → permanently true) ③ upstream requires "log into its own account first" | All three changed to "give feedback / do not get stuck / do not require its own login" |

### 6.1 Methodological lessons (worth more than any single item above)

1. **Using Enter instead of a click to verify** → missed the "button disabled" bug for several rounds (Enter goes through `onKeyDown`, which does not check disabled)
2. **Treating "verified on mobile" as "verified on desktop too"** → this sub-app **has two different top bars, welcome page and in-match**, and we missed the desktop top-bar padding
3. **A probe polluting its own experimental conditions** → my modal-close logic had a "click the last button" fallback, which could turn off "AI voice" in the settings modal, and then I went and measured "why is there no voice"
4. **Shell escaping corrupting the payload** → I once concluded wrongly that "the charge did not take effect" (in reality the request never went out)
5. **Deleting a JSX element disturbs ternary/conditional structure** → removing the "Sign In" button left an empty `else` branch and broke the build twice
6. **Text replacement without assertions fails silently** → the fixed procedure: **back up first → assert and verify → do not write to disk if verification fails → re-verify with a build**

### 6.2 Still incomplete (do not treat as fixed)

1. **Real-time triggering of player-speech voice (`/api/tts`) is unverified** — needs a completed night action or the match to reach daytime speeches; narrator voice (`/audio/narrator/*.mp3`) is verified as playing (with `NarratorAudioPlayer: Playing → Started → Ended` logs).
2. **Occasional `400 POST /api/chat`** — traced to the only 400 branch in my route (`messages must not be empty`), i.e. some call during a match sends empty `messages`; **not reliably reproducible, caller not located**. A persistent diagnostic has been planted in the route (prints only on the exceptional path), so the next occurrence can be matched directly.
3. Generating personas without repetition at startup (caching/reusing the same batch of characters) is not done.
4. The `.ww-scope` token mapping covers only a few common names and has not been checked one by one.

---

<a id="zh"></a>

# AI 狼人杀 · 移植台账（wolfcha → 小愈）

> 策略（用户拍板）：**先把 wolfcha 完整搬进仓库，再逐个文件改成适应我们自己的版本。**
> 来源与许可：`src/werewolf/upstream/ATTRIBUTION.md`（Apache-2.0 · commit `78b4a58c6624fac16d78c17b1fdd2a199076d41e` · 上游无 NOTICE · 不使用其商标）

## 0. 为什么不是「直接复制文件」

不是道德顾虑（Apache-2.0 允许），是**结构冲突**：

| | wolfcha | 小愈 |
|---|---|---|
| 应用壳 | Next.js 16 App Router + pnpm workspace + Supabase + Vercel | Vite + React 18 + Express/tsx + 自有 accounts/sqlite + Cloudflare |
| **对局真相存放** | **jotai atom + localStorage（客户端权威）** | **服务端权威**（`api/services/werewolf.ts`） |
| 状态机形态 | `GamePhase` 类继承 + `PhaseManager` | 纯函数 `tickOnce` / `runSystemSteps` / `actorsNeeded` |
| 计费 | tokenpay / Watcha（韩国） | 我们自己的 `quota.ts`（点数账本） |
| 鉴权 | Supabase | 我们自己的 `accounts.ts` |

把它的 `store/game-machine.ts`（1143 行）原样搬进来＝把权威挪进浏览器，会直接毁掉**视角隔离、点数结算、运营端统计**这三样。所以搬运方式是：

> **源码完整 vendor 进 `vendor/wolfcha/`（4.7M / 350 文件）当依据 → 按文件逐个移植功能 → 每个移植项配单测。**

`vendor/wolfcha/` 不在 `tsconfig.include`（只有 `src`/`api`）与 Tailwind content 里，**不进构建**。
需要重新获取时：`git clone --depth 1 https://github.com/oil-oil/wolfcha.git vendor/wolfcha`（然后可删 `.git assets public`）。

## 1. 已 vendor 的完整源码

```
vendor/wolfcha/
├─ LICENSE              ← Apache-2.0 原文（随源码保留，合规要求）
├─ src/                 ← 271 文件 / 3.7M：app(Next) components game hooks i18n lib store types
├─ server/              ← 它的后端契约（tokenpay 等，仅参考）
├─ supabase/            ← DB schema（仅参考其数据结构）
├─ docs/ scripts/       ← 文档与脚本
└─ package.json / next.config.ts / tsconfig.json
```

## 2. 相关代码规模（为什么必须增量）

| 区域 | 行数 | 说明 |
|---|---|---|
| `src/game/phases/*` | **1968** | NightPhase 713 / DaySpeechPhase 504 / VotePhase 453 / BadgePhase 149 / HunterPhase 86 / WhiteWolfKingBoom 63 |
| `src/store/game-machine.ts` | 1143 | 客户端状态机（我们只借其「阶段清单」） |
| `src/hooks/*` | 5727 | 其中 `useGameLogic` 2357、`game-phases/useBadgePhase` 699（警徽流行为参考） |
| `src/lib/game-master.ts` | 2036 | 「法官」编排 + 提示词 |
| `src/lib/game-analysis.ts` | 1788 | 对局分析/复盘 |
| `src/lib/prompt-utils.ts` | 1132 | 提示词增强 |
| `src/lib/llm.ts` | 1115 | 多 provider 客户端（⛔ 我们用 `deepseek.ts`） |
| `src/lib/character-generator.ts` | 752 | AI 生成角色人设 |
| `src/types/game.ts` | 404 | 身份/阶段/模型等类型 |
| 其余小模块 | ~600 | speech-order / vote-rounds / night-visibility / llm-json / deepseek-prompt-scope 等 |

> 与本玩法相关的逻辑合计 **≈ 1.4 万行**。这就是「完整搬」的真实体量，也是为什么按文件推进、每项带测试。

## 3. 逐文件状态

图例：✅ 已移植并验证 ｜ 🟡 部分移植 ｜ ⬜ 未开始 ｜ ⛔ 不移植（附理由）

### 3.1 游戏规则 / 阶段

| wolfcha 文件 | 行数 | 状态 | 说明 |
|---|---|---|---|
| `src/lib/role-configuration.ts` | 13 | ✅ | 8~12 人配比（含白狼王/守卫/白痴）已进 `engine/types.ts` 的 `ROSTERS`；另留我们的 6 人快速局 |
| `src/lib/vote-rounds.ts` | 10 | ✅ | 「结算前的票不进他人上下文」→ `applyVote` 不公开 + `resolveVote` 结算补写 |
| `src/lib/night-visibility.ts` | 13 | ✅ | 「结算≠公布」→ 事件 `audience` 机制 + `resolveNight` |
| `src/game/phases/NightPhase.ts` | 713 | 🟡 | 已移植：守卫→狼→女巫→预言家→结算、守卫不能连守、同守同救死。待核：其余夜间边界 |
| `src/game/phases/HunterPhase.ts` | 86 | ✅ | 等价实现（毒杀不能开枪、连环判定） |
| `src/game/phases/WhiteWolfKingBoomPhase.ts` | 63 | ✅ | 自爆 → 带人 → 当天入夜 |
| `src/game/phases/VotePhase.ts` | 453 | 🟡 | 已移植：投票、PK 加赛、白痴翻牌。待核：警长 1.5 票 |
| `src/game/phases/DaySpeechPhase.ts` | 504 | 🟡 | 已移植：顺序发言、白狼王发言时自爆。待核：警长定发言顺序 |
| **`src/game/phases/BadgePhase.ts`** | **149** | ⬜ | **警徽流：本轮正在做**（类型已加，规则未实现） |
| `src/lib/hunter-badge-flow.ts` | 25 | ⬜ | 猎人 + 警徽交互 |
| `src/lib/historical-vote-snapshots.ts` | 40 | ⬜ | 历史票型快照（复盘/上下文用） |
| `src/lib/speech-order.ts` | 228 | 🟡 | 我们有 `speakOrder`/`speakIndex`；它的「跳过/未发言」细粒度状态更全，待对照 |
| `src/lib/game-constants.ts` / `game-texts.ts` / `scenarios.ts` | 351 | ⬜ | 常量与文案，待对照取值 |
| `src/game/core/*.ts` | 91 | ⛔ | 类继承式阶段管理；用我们的 `tickOnce`/`actorsNeeded` 等价替代 |
| `src/store/game-machine.ts` | 1143 | ⛔ | 客户端权威，与服务端权威冲突（仅借阶段清单） |

### 3.2 AI / 提示词

| wolfcha 文件 | 行数 | 状态 | 说明 |
|---|---|---|---|
| **`src/lib/deepseek-prompt-scope.ts`** | **39** | ⬜ | **真实缺口**：DeepSeek 前缀缓存稳定前缀（实测我们 `prompt_cache_hit_tokens: 0`） |
| `src/lib/game-master.ts` | 2036 | 🟡 | 我们已自研 `ai/prompt.ts` + 编排；它以「法官流程 + 提示词」作对照参考 |
| `src/lib/prompt-utils.ts` | 1132 | ⬜ | 提示词拼装增强（缓存消息构造等） |
| `src/lib/llm-json.ts` | 86 | 🟡 | 我们有 `parseDecision`/`extractJsonObject`；它接了 `ai-json-fixer`，待评估是否值得引 |
| `src/lib/ai-config.ts` | 49 | ⬜ | 温度等参数 |
| `src/lib/streaming-speech-parser.ts` | 200 | ⬜ | 流式发言解析（配 SSE） |
| `src/lib/character-generator.ts` | 752 | ⬜ | AI 生成角色人设（我们有「聊一聊」角色，优先级低） |
| `src/lib/llm.ts` | 1115 | ⛔ | 多 provider + 密钥管理；用我们的 `api/services/deepseek.ts` |

### 3.3 对局外围

| wolfcha 文件 | 行数 | 状态 | 说明 |
|---|---|---|---|
| `src/lib/game-analysis.ts` | 1788 | 🟡 | 我们的复盘卡是它的子集；待对照补「关键回合分析」 |
| `src/hooks/game-phases/useBadgePhase.ts` 等 | ~1000 | 🟡 | 警徽流/白天流程的**行为参考**（我们搬到服务端） |
| `src/hooks/useGameLogic.ts` | 2357 | ⛔ | 客户端编排；我们的编排在 `api/services/werewolf.ts` |
| `src/hooks/useCredits.ts` / `useTokenPay.ts` | 961 | ⛔ | 计费用我们自己的 `quota.ts` |
| `src/types/game.ts` | 404 | 🟡 | 身份/阶段枚举已移植；`ModelRef`/多模型不迁 |
| `src/types/analysis.ts` | 149 | ⬜ | 分析数据结构（复盘增强时用） |
| `src/app/*`、`src/components/*` | — | 🟡 | Next.js App Router + Radix，**不搬组件**；改为**照它的设计 token 重画**（见下方 §5） |
| tokenpay / watcha / supabase / referral / welfare | — | ⛔ | 按用户要求：密钥与登录用我们自己的 |

## 5. 视觉层：复古暗调（用户 2026-09-15 选 B）

**做法是复刻设计 token，不是搬组件、也不是照截图眼调。**

来源：wolfcha `src/app/globals.css` 的变量表（已 vendor，本地可查）：

| 用途 | 上游变量 | 取值 |
|---|---|---|
| 陈金（主色 / CTA） | `--color-gold` / `--color-accent` | `#c5a059`（亮 `#d4b06a` / 暗 `#8c7335`） |
| 血色（狼阵营 / 警示） | `--color-blood` | `#8a1c1c`（亮 `#b93636`） |
| 羊皮纸（正文） | `--paper` | `#f0e6d2` |
| 夜色底 | `--bg-night-from/via/to` | `#1a1614 → #14100e → #0d0a08` |
| 卡片面 | `--bg-dark` | `#1a1614` |
| 弱化文字 | `--text-muted` | `#9c8570` |
| 金描边 | `--border-color` | `rgba(140,115,53,0.25~0.38)` |
| 字体 | `--font-title` / `--font-chinese` | Cinzel / Noto Serif SC |
| 身份色 | `--color-wolf/seer/witch/hunter/guard/villager` | `#8a1c1c / #2c5282 / #6b46c1 / #c05621 / #276749 / #5c4a3d` |

**实现方式**（贴合项目自身架构）：项目 Tailwind 的颜色**全部引用 CSS 变量**，且本来就有 `<html data-skin>` 换肤机制。
所以新增 `src/werewolf/theme.css`，在 `.ww-theme` 作用域内**重映射这套变量**即可，既有组件类名一行不用改。

- 主题 CSS 作为**独立分包**随狼人杀页面懒加载（`WerewolfPage-*.css` 1.12 kB），**全站品牌色零影响**
- `bg-white` → `bg-clay-surface`（新增的 `surface` 记号），避免暗底上出现亮白卡
- 字体：`--skin-display-font` 用 `Cinzel, 'Ma Shan Zheng', 'Songti SC', serif`——
  Cinzel 未自托管，用**项目已有的书法体 Ma Shan Zheng** 兜住「古」的味道，不引新字体资产

> ⚠️ **品牌红线 #4 的放宽范围：仅限 `.ww-theme` 作用域（狼人杀这一屏）**，全站品牌色（主绿 #1FA46B / 奶油底 #FBF6EE）不变。
> 这是用户明确拍板的选择（A 功能对齐保品牌 / **B 照它重画** / C 混合 → 选 B）。


## 4. 下一步顺序（按价值）

1. **警徽流**（`BadgePhase.ts` 149 行 + `useBadgePhase.ts` 699 行参考）：上警报名 → 竞选发言 → 投票选警长 → 警长出局移交警徽；警长 1.5 票、定发言顺序
2. **DeepSeek 前缀缓存**（`deepseek-prompt-scope.ts` 39 行）：直接降本，且我们已实测未命中
3. 警长 1.5 票 + 定发言顺序接进现有投票/发言
4. 8/10/11 人局前端真机（配置已在引擎并有单测，UI 未验）
5. 流式发言（SSE）+ `streaming-speech-parser`
6. 复盘增强（`game-analysis`）、AI 生成人设、语音/观战
7. **视觉层**：它的复古暗调与项目品牌色红线（#1FA46B / #FBF6EE）冲突，需产品决策后再动


---

## 6. 2026-09-16 大修：七个"看起来是别人的 bug、其实是我们自己造成的"

这一轮把「准备开始慢」「刷新丢局」「语音不响」三件事查到底，结论高度一致：
**症状在上游的代码里，根因在我们自己的移植层。** 记在这里以免后人重走。

| 症状 | 真正的原因 | 修在哪 |
|---|---|---|
| 刷新网页丢对局（回到签名页） | 我们的 `gameSessionTracker` 桩**所有方法都返回同一个对象**，而 `start()` 的返回值会被**直接当作 `gameSessionId`** 存进对局状态；`hasGameSessionId()` 要求它 `typeof === 'string'` → 每次保存都判定"不可恢复"→ **主动删掉存档** | `src/wolfcha/lib/game-session-tracker.ts`：`start()` 返回字符串 id |
| 「旁边语音」永远不响 | **不是坏了**：上游在 `onStart` 与 `GAME_END` 两处 `setAiVoiceEnabled(false)`，把 false **持久化**进本地设置 → 下一局读到的还是 false | `src/wolfcha/app/page.tsx`：去掉这两处调用 |
| 手机端弹窗被推出屏幕（左边缘 -172px） | 同一个 `translate-x-[-50%]` 被**两个 Tailwind 各生成一次**（我们的 v3 也在扫 `src/wolfcha` → `transform`；v4 → `translate` 属性），居中做了两次 | `tailwind.config.js` 把 `src/wolfcha` 排除出 v3 `content` + `public/wolfcha-overrides.css` 钉死为一种实现 |
| 它界面里出现**我们的**品牌绿 | 我们的 token 定义在 `:root`，而它们命名是 `--bg-*`，**不定义** `--color-ring` 这些名字 → 组件引用时吃到我们的主绿 | `public/wolfcha-overrides.css` 里 `.ww-scope` 作用域映射回上游色板 |
| 自定义角色永远 0/20 | 上游把它存在 **Supabase**，而小愈不用 Supabase（已打桩）→ 读写全落空（**死功能**） | 重写 `src/wolfcha/hooks/useCustomCharacters.ts` 数据层：接入 `/api/analysis/chat/characters` + 本地持久化 |
| 开局「准备开始」36 秒 | 批次是 `Promise.allSettled` **并行**的 → **墙钟由最慢的一批决定，不是批次数量**。3 人一批每批写 ~3300 token → 单批 19~22s | `CHARACTER_PERSONA_BATCH_SIZE` **3 → 1** + 强制 `reasoning_effort: 'none'`，**22.8s / 23.8s 两次稳定** |
| 印章"点了没反应" | 三道门叠着：①按钮 `disabled` 表达"名字为空"（**不给任何反馈**）②`canConfirm` 依赖 `creditsLoading`（初值 true 且无 user 时不清除 → 永久 true）③上游要求"先登录它自己的账号" | 三处都改成"给反馈/不卡死/不要求它自己的登录" |

### 6.1 方法论上的教训（比上面任何一条都值钱）

1. **用回车代替点击验证** → 漏掉了"按钮 disabled"这个 bug 好几轮（回车走 `onKeyDown`，不检查 disabled）
2. **把"手机验过"当成"桌面也验过"** → 这个子应用**欢迎页与对局内是两套顶栏**，漏了桌面端顶栏留白
3. **探针污染自己的实验条件** → 我的弹窗关闭逻辑带"点最后一个按钮"兜底，结果可能在设置弹窗里把「AI 语音」关掉，然后我又去测"为什么没语音"
4. **shell 转义把 payload 弄坏** → 曾据此得出"扣费没生效"的错误结论（真实情况是请求根本没发出去）
5. **删 JSX 元素会牵动三元/条件结构** → 删「Sign In」按钮留下空 `else` 分支，构建挂了两次
6. **不加断言的文本替换会静默失败** → 固定做法：**先备份 → 断言校验 → 校验不过不落盘 → 构建复核**

### 6.2 仍未完成（勿当作已修）

1. **玩家发言的语音（`/api/tts`）实时触发未验证** —— 需要完成一次夜间行动或让对局走到白天发言；旁白语音（`/audio/narrator/*.mp3`）已验证在播（有 `NarratorAudioPlayer: Playing → Started → Ended` 日志）。
2. **偶发 `400 POST /api/chat`** —— 已定位到我路由里唯一的 400 分支（`messages 不能为空`），即对局中某个调用会发空 `messages`；**复现不稳定，调用方未定位**。已在路由里埋常驻诊断（异常路径才打印），下次出现可直接对上。
3. 启动时不重复生成人设（缓存/复用同一批角色）未做。
4. `.ww-scope` 的 token 映射只覆盖了几个常用名，未逐个核对。
