# Roleplay Dual-Mode Plan (single-character vs multi-character, per scenario)

> Status: **phases 1–2 landed** (CHANGELOG #60), **phase 3 nearly done** (#61 first ten, #62 the next nine batches → **29 of 30 scenarios have a cast**; the hold-out is 沦为玩物的亡国公主, deliberately solo-only); **phase 4 pending** (tap-to-speak / LLM router)
> Scope: every official scenario gets a **solo** and a **multi** version; one save slot each
> Builds on: #54–#59c (the multi-character feature and cast avatars that already ship)
> Decisions taken (2026-10-01, "按你推荐的来做"): A + tap-to-speak later · multi-only sub-lines for the ones that do not fit · badge → 群像可选 and the filter removed · same background, per-mode opening
> Bilingual, English first; the Chinese original is under [中文原文](#zh).

---

## 1. TL;DR

1. Make `mode` (**solo** | **multi**) a **first-class dimension** of a roleplay session, so one scenario = two independent story lines with **one save slot each** — exactly the model you asked for.
2. Save key changes from `userId::scenarioId` to `userId::scenarioId::mode`. Existing rows have no `mode` → treat as **solo** and re-key lazily (no bulk rewrite).
3. **The one architectural fork** is *how multiple characters take turns*. Industry practice offers two shapes; they trade control against cost (§3). We already ship the cheap one.
4. All 30 scenarios need a cast, and some genuinely do **not** fit multi-character. Your rule — add story material rather than force it — is the right one, but it is **authoring work**, not code (§5).
5. ⚠️ **Direct consequence for what we just shipped**: once every scenario has both modes, the list's 「多角色/单角色」 filter and badge become meaningless. They must be repurposed (§4.3).

---

## 2. How comparable products do it (research)

| Product | Model | What is worth copying |
|---|---|---|
| **SillyTavern** (group chats) | A group chat is a **separate save** from 1:1. **Reply order**: @natural@ (the model picks) / @list@ (fixed order) / @manual@ (you pick). **Auto-mode** asks the LLM "who speaks next". Individual characters can be **muted**. Each character keeps its own card; `@name` addresses one. | The reply-order switch and mute are the two features that make a group chat controllable. |
| **Character.AI** (Rooms) | Multi-bot rooms existed and were **retired in 2024**. Widely attributed to bots talking over each other, incoherence, cost and moderation surface. | The negative lesson: "let the AIs chat" without user controls degrades fast. |
| **星野 / 猫箱 / Talkie** | Multi-role is a **mode on a story**, with a **cast list** of author-written characters. | Pre-authored casts (not improvised ones) — which is what we already do. |
| **Agnai / Vellium** (OSS) | Multi-bot sessions, per-character cards, group-level prompt. | Group-level prompt overlay ≈ our @buildMulticastBlock@. |

**Common denominator**: (1) group chat = its own save; (2) there is always a rule for *who speaks*; (3) characters are cards; (4) the user can always intervene.

---

## 3. The one fork: how characters take turns

| | **A · one reply, everyone** (shipped) | **B · turn-based, one speaker per turn** (SillyTavern-style) |
|---|---|---|
| Calls per beat | 1× | N× for N speakers |
| Pacing / no talking over each other | model's own judgement — **can hog or skip a character** | fully controlled |
| Cost / latency | unchanged | N× |
| Speaker chosen by | the model | LLM router / round-robin / **user tap** |
| Verdict | keep as the **default** | add the **user-tap** flavour first |

**Recommendation: A by default + "tap a character to make them speak alone"** — one extra call *only when the user asks*, which is 90% of B's control at a fraction of the cost. An LLM router (§6 Q1) can come later.

---

## 4. Design for this codebase

### 4.1 Data
- **Scenario level**: finish `SCENARIO_CAST` for all 30 scenarios (name / role / one-line intro / avatar / `lead`), and allow a **per-mode story block** — `multiOpeningScene`, `multiOpeningAssistant`, optionally `multiBackground` — so the two versions can open differently (§6 Q5).
- **Session level**: add `mode` to `RoleplaySessionRecord`; key becomes `userId::scenarioId::mode`.
  - Legacy rows: missing `mode` ⇒ **solo**; re-key on first read (lazy), never bulk-rewrite the file.
  - `getRecord / listByUser / heal` take an optional `mode`; when omitted they return the **most recently updated** of the two, which keeps existing callers (journey, storyBridge, admin, reengage, selfHeal, review) behaving sensibly.
- **Generation**: today the cast block is injected whenever `cast.length >= 2`. It must instead follow the **request's mode** — a user replaying the solo line must never get the cast injected.

### 4.2 Save slots
One scenario ⇒ at most **two** records per user (solo + multi), independent messages, preference and 「重新开始」. That is precisely "each scenario gets at most one multi save and one solo save".

### 4.3 UI consequences
- **Detail page**: a mode switch (单角色 / 多角色) with one line of difference and a per-mode 「有存档·续演」 hint; the start button uses the selected mode.
- **List**: the badge becomes 「群像可选」 (both modes available) and the **filter is removed** — with both modes everywhere it no longer separates anything (or it could mean "我只想看还没玩过的多人线", which is a weaker idea).
- **与你的旅程 / admin console**: each record needs a mode label, otherwise one scenario shows up twice with no explanation.

### 4.4 Blast radius (measured, not guessed)
24 call sites touch the session store: `api/routes/roleplay.ts` (get/save/savePreference/delete), `auth.ts` (deleteByUser), `mergeGuest.ts` (reassignUser), `journey.ts` (listByUser), `storyBridge.ts` (getRecord ×3), `selfHeal.ts` (listAll/getRecord/heal), `reengage.ts`, `reviewBuilder.ts`, `adultCampaign.ts`, `holidayGiftMail.ts`, `paymentAdmin.ts` (×6). All must stay correct; the optional-`mode` default above is what keeps that manageable.

---

## 5. Content: casts for 30 scenarios

Sample (to be extended into a full table you can review):

| Scenario | Proposed cast (beyond the lead) | Story basis |
|---|---|---|
| 替姐出嫁那夜 | **林家长女（逃婚的姐姐）**, 李嬷嬷, 翠屏 | the sister's flight *is* the premise |
| 冷峻刑警的年下法医 | 刑警队搭档, 法医室主任, 嫌疑人 | 凶案现场 always implies a team |
| 高冷女总裁的落魄助理 | 副总, 女秘书, 债主 | office politics is already in the premise |
| 他等了我十五年 | 司机老陈, 生意对手, 她的朋友 | the guardian's world implies witnesses |
| 乖乖，别抛弃我 | 经纪人, 同剧女星, 沈家母亲 | 娱乐圈 premise |
| 疯批总裁的白月光 | 秘书, 讨债人, 陆家二叔 | the chase implies muscle |

**Scenarios that may not fit multi-character** (very private 1:1 scenes, e.g. 温柔女医生的清晨查房, 哑巴新娘的独处): two honest options — (a) write a **multi-only sub-line** for that scenario (a new scene/stage where colleagues or family plausibly appear), or (b) mark it **solo-only** and **add a new multi-character scenario** in the same genre. Your own instruction allows both; I recommend (a) where the premise has any social surface and (b) as the fallback.

**The 姐姐**: yes — she belongs in 替姐出嫁那夜's cast. She can enter in a later beat (found, or returning on her own). Note the prompt forbids flashbacks, so she cannot be introduced through memory; she has to walk in.

---

## 6. Decisions needed

- **Q1 — turn-taking**: ship "A (one reply) + tap-to-make-one-speak" (recommended), or go straight to an LLM router / full turn-based mode?
- **Q2 — the ones that do not fit**: write a multi-only sub-line, or mark solo-only and add new multi-character scenarios?
- **Q3 — quota**: multi stays 1 call = same cost. If we add turn-based mode, does each *character reply* consume a turn, or does a full round stay one turn?
- **Q4 — list UI**: badge → 「群像可选」 and remove the filter (my recommendation), or repurpose the filter?
- **Q5 — how far should the two lines diverge**: same background with a different opening, or genuinely different branches (much more writing)?

---

## 7. Phasing

| Phase | Work | Output |
|---|---|---|
| 1 | `mode` on the record + `::mode` key + optional-mode defaults in every caller | ✅ **done (#60)** — dual save slots, invisible in the UI |
| 2 | Detail-page mode switch; list badge/filter rework; journey/admin mode labels | ✅ **done (#60)** — badge is 群像可选, filter removed, per-mode opening shown |
| 3 | Cast for all 30 scenarios + per-mode openings | 🟡 **in progress** — **29 of 30** done (#61 the first ten, #62 the next nine), each with lead + 3 supporting characters and a story-appropriate portrait. **The one hold-out is 沦为玩物的亡国公主** (verdict: strong 1v1 + sensitive premise ⇒ multi would weaken both the设定 and the compliance line); per your rule it needs a **new companion scenario** of the same subject rather than a forced cast. Scenarios without a cast simply offer solo only — the mode switch is not rendered |
| 4 | Tap-a-character-to-speak; then (optional) LLM router | group-chat control |

---

<a id="zh"></a>

# 多角色/单角色「双模式」方案

> 状态：**方案稿，未改代码**，等你拍板 §6 的五个问题
> 范围：全部官方剧本都要有**单角色版**与**多角色版**，各一份存档
> 基础：承接 #54–#59c（已上线的多角色功能与配角头像）
> 英文在前，中文原文见下。

---

## 1. 结论摘要

1. 把 `mode`（**solo** / **multi**）做成一等维度：一部剧本 = **两条独立剧情线**，**各存一档** —— 正是你要的「每部最多一个多角色 + 一个单角色存档」。
2. 存档键从 `userId::scenarioId` 改成 `userId::scenarioId::mode`。老数据没有 `mode` ⇒ 一律当 **solo**，第一次读取时惰性改键（**不整份重写**）。
3. **唯一的关键分叉是「多个角色怎么轮流说话」**。业界两种形态，各在可控性与成本上取舍（§3）；便宜的那种我们已经上线了。
4. 30 部剧本都要配 cast，而且**确实有些剧本天生不适合多角色**。你的口径（宁可加剧情也不硬凑）是对的，但那是**写作量**，不是代码问题（§5）。
5. ⚠️ **对我们刚上线的东西的直接影响**：等所有剧本都有两个版本后，列表页的「多角色/单角色」筛选和角标就**失去意义**了，必须改义（§4.3）。

## 2. 同类产品怎么做的（调研）

| 产品 | 形态 | 值得抄的 |
|---|---|---|
| **SillyTavern**（群聊） | 群聊是**独立存档**；**发言顺序**可选 @natural@（模型自己挑）/ @list@（固定顺序）/ @manual@（你点）；**auto-mode** 让 LLM 决定「下一个谁说话」；单个角色可**静音**；每角色一张卡；用 `@名字` 指定对象 | 「发言顺序开关 + 静音」是让群聊可控的两个关键功能 |
| **Character.AI**（Rooms） | 多机房间**2024 年下线**（官方未细说），普遍归因于机器人互相刷屏、连贯性差、成本与审核面大 | **负面教训**：不给用户控制权的「让 AI 自己聊」会迅速失控 |
| **星野 / 猫箱 / Talkie** | 多角色是剧情上的**一个模式**，配**作者写好的角色列表** | 预先写好的 cast（不是让模型现编）—— 正是我们现在的做法 |
| **Agnai / Vellium**（开源） | 多机会话 + 每角色卡 + 群组级 prompt | 群组级 prompt ≈ 我们的 `buildMulticastBlock@ |

**共同点**：① 群聊＝独立存档；② 一定有「谁说话」的规则；③ 角色是卡；④ 用户永远能介入。

## 3. 唯一的分叉：角色怎么轮流说话

| | **A · 一次回复写所有人**（已上线） | **B · 逐轮发言，一轮一个角色**（SillyTavern 式） |
|---|---|---|
| 每个节拍的调用数 | 1× | N 个说话人 = N× |
| 节奏 / 会不会抢话 | 靠模型自觉 —— **可能一个人说太多、也可能漏掉某人** | 完全可控 |
| 成本 / 延迟 | 不变 | N× |
| 谁决定发言 | 模型 | LLM 路由 / 轮转 / **用户点** |
| 结论 | 保留为**默认** | 先做**「用户点」**这一种 |

**建议：默认走 A，再加「点某个角色头像 → 只让 TA 单独说这一轮」** —— 只在用户主动要求时多一次调用，用很小的成本拿到 B 九成的可控性。LLM 路由（§6 Q1）以后再说。

## 4. 本项目设计

### 4.1 数据
- **剧本级**：把 `SCENARIO_CAST` 补全到 30 部（名字 / 身份 / 一句话介绍 / 头像 / `lead`），并允许**按模式分剧情块** —— `multiOpeningScene`、`multiOpeningAssistant`、可选 `multiBackground` —— 这样两个版本可以有不同开场（§6 Q5）。
- **会话级**：`RoleplaySessionRecord` 加 `mode`；键变 `userId::scenarioId::mode`。
  - 老数据缺 `mode` ⇒ 当 **solo**；第一次读取时惰性改键，**绝不批量重写文件**。
  - `getRecord / listByUser / heal` 加可选 `mode`；不传时返回两份里**最近更新**的那份 —— 这样既有的调用方（与你的旅程 / storyBridge / 管理端 / 召回 / 自愈 / 审阅）行为仍然合理。
- **生成**：现在只要 `cast.length >= 2` 就注入群像块。应改成**听请求里的 mode** —— 用户在演单角色线时，绝不能把 cast 注入进去。

### 4.2 存档槽
一部剧本对每个用户**最多两条记录**（solo + multi），消息、偏好、重新开始互相独立。就是「每部最多一个多角色 + 一个单角色存档」。

### 4.3 界面后果
- **详情页**：模式选择（单角色 / 多角色），各带一句差异说明与「有存档·续演」；开始按钮跟所选模式走。
- **列表**：角标改成「群像可选」（两个版本都有），**筛选移除** —— 人人都有两版之后它不再区分任何东西（或改成「只看没玩过的群像线」，但那是个更弱的主意）。
- **与你的旅程 / 管理端**：每条记录要带模式标签，否则同一部剧本会出现两条记录且无法解释。

### 4.4 影响面（实测，不是猜的）
24 处调用方碰过会话存储：`api/routes/roleplay.ts`（get/save/savePreference/delete）、`auth.ts`（deleteByUser）、`mergeGuest.ts`（reassignUser）、`journey.ts`（listByUser）、`storyBridge.ts`（getRecord ×3）、`selfHeal.ts`（listAll/getRecord/heal）、`reengage.ts`、`reviewBuilder.ts`、`adultCampaign.ts`、`holidayGiftMail.ts`、`paymentAdmin.ts`（×6）。上面那个「`mode` 可选」的默认值是让这件事可控的关键。

## 5. 内容：30 部剧本的 cast

样例（可以扩成一张完整的表给你审）：

| 剧本 | 建议 cast（主角之外） | 剧情依据 |
|---|---|---|
| 替姐出嫁那夜 | **林家长女（逃婚的姐姐）**、李嬷嬷、翠屏 | 姐姐逃婚**就是**前提本身 |
| 冷峻刑警的年下法医 | 刑警队搭档、法医室主任、嫌疑人 | 凶案现场必然有团队 |
| 高冷女总裁的落魄助理 | 副总、女秘书、债主 | 办公室政治本来就在设定里 |
| 他等了我十五年 | 司机老陈、生意对手、她的朋友 | 监护人的世界有旁观者 |
| 乖乖，别抛弃我 | 经纪人、同剧女星、沈家母亲 | 娱乐圈前提 |
| 疯批总裁的白月光 | 秘书、讨债人、陆家二叔 | 追逃必然有帮手 |

**可能不适合多角色的**（极私密的 1v1，如《温柔女医生》清晨查房、《哑巴新娘》独处）：两条路 —— (a) 为该剧本写**只属于多角色的支线**（换一个社会性的场景/阶段，让同事或家人自然地出现），或 (b) 明确标 **solo-only**，另补一部同题材的多角色新剧本。你的口径两条都允许；我建议「前提里但凡有社会关系就选 (a)，否则 (b) 兜底」。

**姐姐**：应该加进《替姐出嫁那夜》的 cast。她可以在后段登场（被找回，或自己回来）。注意提示词禁止闪回，所以不能靠回忆出场 —— 她得真人走进来。

## 6. 需要你拍板

- **Q1 轮流发言**：就做「A + 点名让某人单独说」（推荐），还是直接上 LLM 路由 / 完整逐轮模式？
- **Q2 不适配的那些**：写多角色专属支线，还是标 solo-only 并另出多角色新剧本？
- **Q3 额度**：多角色一次调用＝同成本。若加逐轮模式，每个角色的回复各算一回合，还是一个完整轮算一回合？
- **Q4 列表 UI**：角标改「群像可选」+ 移除筛选（我的建议），还是给筛选换个含义？
- **Q5 两条线能差多少**：同背景不同开场，还是完全不同的支线（写作量大得多）？

## 7. 分期

| 阶段 | 内容 | 产出 |
|---|---|---|
| 1 | 记录加 `mode` + `::mode` 键 + 所有调用方支持可选 mode | ✅ **已完成（#60）** —— 双存档，界面还看不出来 |
| 2 | 详情页模式开关；列表角标/筛选重做；旅程与管理端加模式标签 | ✅ **已完成（#60）** —— 角标改「群像可选」、筛选移除、开场随模式 |
| 3 | 30 部剧本的 cast + 分模式开场 | 🟡 **进行中** —— **30 部里完成 29 部**（#61 首批十部、#62 再九部），每部主角 + 3 配角且都配了符合剧情的头像。**唯一留白是《沦为玩物的亡国公主》**（判定：强 1v1 + 题材敏感，做群像会同时削弱设定与合规口径）；按你的口径，它该配的是**同题材的新剧本**，而不是硬凑 cast。没有 cast 的剧本自动只提供单角色线——模式开关不渲染 |
| 4 | 点名让某角色说话；之后（可选）LLM 路由 | 群聊可控性 |
