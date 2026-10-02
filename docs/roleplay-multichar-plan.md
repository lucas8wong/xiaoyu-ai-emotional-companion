# Roleplay Multi-Character Plan (multi-speaker turns · per-character bubbles · streamed opening)

> Status: **research draft — no code changed**; three decisions needed (§7)
> Scope: Xiaoyu roleplay — `api/services/roleplay.ts`, `api/routes/roleplay.ts`, `src/components/RoleplayPage.tsx`, `roleplaySessions`
> Related: `docs/roleplay-immersion-plan.md` §4.1 (multi-character segmentation is listed there as the hardest open S1 item), `docs/roleplay-bgm-plan.md`
> Bilingual with **English first**; the Chinese original is under [中文原文](#zh).

---

## 1. Key conclusions (TL;DR)

1. **Multi-character is not a new generation pipeline.** The roleplay system prompt *already* tells the model it may play several characters at once — `_COMMON_RULES_TEXT_ZH` rule 8 ("合理安排每个角色的出场时间和顺序…可以一次扮演一人或多人对话") and `CLASSIC_RULES_TEXT_ZH` §二 "NPC 调度规则". What is missing is only **(a) a speaker-label protocol** and **(b) per-speaker rendering**.
2. **The streaming infrastructure is complete.** `?stream=1` SSE (delta / queue / meta / continue / rewrite / done) + `roleplayChatStream` already stream token-by-token into one bubble.
3. **Recommended route A**: one streaming call, each speaker's block prefixed with `【name】`, parsed into segments. Cost/latency stay **1×**, and every downstream consumer of the text keeps working.
4. **Per-bubble streaming needs no server change on the delta path.** The client already re-renders the *whole accumulated* text on every frame (`RoleplayPage.tsx:1960-1966`, `full += delta`), so a streaming-tolerant parser can split it live — character A's bubble grows, then B's bubble appears and grows, and so on.
5. **The opening is static today.** `openingAssistant` is authored data injected whole by `pickInitialMessages` (`src/lib/rpInitialMessages.ts`) → it appears instantly. To make the first message stream: **O1** author it with tags + a client typewriter (cheap, recommended), or **O2** generate it with AI (dynamic, costs a turn and adds a new failure path at entry).
6. **Bonus**: explicit speaker tags also unblock S1-c (multi-character TTS voice segmentation) — the one item `roleplay-immersion-plan.md` §4.1 calls "本层最难的点".

---

## 2. Inventory: what already exists (do not rebuild)

| Capability | Where | State |
|---|---|---|
| SSE streaming transport | `api/routes/roleplay.ts:397-489` (`?stream=1`) | ✅ delta/queue/meta/continue/rewrite/done |
| Streaming client | `src/services/api.ts:1504` `roleplayChatStream` | ✅ |
| Whole-text accumulation per frame | `src/components/RoleplayPage.tsx:1960-1966` | ✅ |
| Text segmentation (narration / dialogue / thought) | `src/lib/roleplayText.ts` `parseRoleplayText` | ✅ **but no speaker dimension** |
| Rich renderer | `src/components/RoleplayRichText.tsx` | ✅ |
| Multi-character *permitted* by prompt | `roleplay.ts:51` rule 8; `roleplay.ts:137` §二 | ✅ (unlabelled) |
| Opening injection | `src/lib/rpInitialMessages.ts` | ⚠️ static, instant |
| `【…】`-prefix stream filter | `src/lib/beatPlan.ts` (`【本拍】`/`[BEAT]`) | ✅ compatible with `【name】` |
| Cast model precedent (in-repo) | `src/wenyou/engine/types.ts` `CastDraft/CastMember`, `src/wenyou/ui/castHighlight.ts` | inline highlight, **not** bubbles |
| Scenario side tables | `roleplay.ts:409` `SCENARIO_AUDIENCE`, `roleplay.ts:442` `SCENARIO_TAGS` | pattern to copy for cast |

---

## 3. Three technical routes

| | A · speaker-tag protocol **(recommended)** | B · JSON structured output | C · one call per character |
|---|---|---|---|
| Shape | one streaming call; each block starts with `【name】` | model returns `[{speaker,text}]` | call once per cast member per turn |
| Cost / latency | 1× (unchanged) | 1× | **N×** (plus serial calls) |
| Per-bubble streaming | natural (parse the live text) | poor (must buffer/partially parse JSON) | natural |
| Regression risk | low (adds a parser + prompt block) | **high** — breaks quote normalisation, beat-plan strip, anti-repeat, auto-continuation, repeat-gate, safety check, session save, share image, TTS | high — needs a quota model rework; characters cannot see each other's same-turn lines |
| Verdict | **do this** | no | no (at least not for a trial) |

---

## 4. Recommended design (route A)

### 4.1 Data
Add a side table next to the existing ones (same shape and rationale as `SCENARIO_AUDIENCE` / `SCENARIO_TAGS`):

```ts
interface CastMember { id: string; zh: string; en: string; avatar?: string }
const SCENARIO_CAST: Record<string, CastMember[]> = { /* ... */ };
```

`cast.length >= 2` turns multi-character mode on for that scenario. Surface it through `flatScenario()` and the client type `RoleplayScenarioInfo` (`src/services/api.ts:1398-1403`) as a localised `cast?: { id; name; avatar? }[]`.

### 4.2 Prompt
Add `buildMulticastBlock(lang, cast)` to `api/services/roleplay.ts`, injected by `composeRoleplaySystem` between the rules and the task instruction (order is already pinned by unit tests). Rules: every segment starts with `【名字】`; only the listed names may speak; narration may omit the tag (neutral); never invent unnamed speakers; keep 1–3 speakers per turn; never translate or alter the name inside the tag. Ablation flag `RP_MULTICAST=0` (the project's existing convention).

### 4.3 Parsing
New pure module `src/lib/roleplayCast.ts`:
`parseCastSegments(text, castNames): { speaker: string | null; text: string }[]`
- recognises `【name】` at line start when `name ∈ cast`;
- **streaming-tolerant**: a trailing unterminated `【…` is held back, never rendered as narration;
- an unknown `【…】` falls through as ordinary text (never silently swallowed);
- idempotent and character-preserving (same three hard constraints as `roleplayText.ts`);
- unit-tested alongside `test/unit/roleplayText.test.ts`.

### 4.4 Rendering
In `RoleplayPage`, when a scenario has a cast **and** the parsed segments contain at least one speaker, render one bubble per segment: avatar + name label for speakers, a visually quieter no-name bubble for narration. Otherwise, exactly today's single bubble (fallback). Avatars fall back to an initial circle when `avatar` is absent.

### 4.5 Streaming
**No server change required on the delta path.** The client keeps accumulating tagged text and re-parses each frame; `done.reply` still replaces the streamed text at the end. Regenerate / edit / version-switch / repeat-gate / session save all keep operating on the whole tagged turn.

*Optional hardening*: emit a `{type:'speaker'}` SSE event so the bubble boundary is crisp even when a tag is split across deltas — not needed for v1.

### 4.6 Opening ("the first message streams")
- **O1 (recommended)**: author the converted scenarios' `openingAssistant` with `【name】` tags, and on entering a *fresh* session play it through a client typewriter that reveals one segment at a time. Zero AI cost, deterministic, no new failure path.
- **O2**: generate the opening with AI on first entry (needs a new opening mode that does not require a user turn, or a synthetic hidden turn), streamed like a normal reply. Dynamic, but costs quota, adds entry latency, and creates a generation-failure path exactly where today there is none.

---

## 5. Candidate scenarios

Ranked by existing likes and by how naturally a second character already exists in the premise.

| Scenario id | Title | Lead AI | Natural extra cast |
|---|---|---|---|
| `lutingyuan-shenyan` | 冷峻刑警的年下法医 | 陆庭深 | partner detective / suspect / 法医室同事 |
| `shenshu-jiangjia` | 乖乖，别抛弃我 | 沈殊 | agent / rival / 家族长辈 |
| `guyushen-songzhi` | 他等了我十五年 | 顾聿深 | 朋友 / 司机 / 生意对手 |
| `peixiuyuan-linwantang` | 替姐出嫁那夜 | 裴修远 | 姐姐 / 婆母 / 侍女 |
| `shenqingyi-luchi` | 高冷女总裁的落魄助理 | 沈清漪 | 副总 / 同事 / 债主 |
| `guwanqing-heyu` | 傲娇大小姐 | 顾晚晴 | 情敌 / 管家 |

---

## 6. Risks and regression surface

- **Every consumer of raw `content` must be checked**: long-image share (`StoryShareModal`), TTS (`src/lib/storyVoice.ts`), session persistence, anti-repeat (`collectAvoidPhrases`), output safety (`checkAiOutputSafety`), zh-TW conversion (`normalizeRplangText`). Tags are harmless to safety, but must be stripped for share/TTS/anti-repeat or `【陆庭深】` leaks into the shared image and the spoken text.
- **Name protection**: `protectedNames` must include every cast name, or zh-TW conversion may alter the tag.
- **Quote normalisation**: the per-language dialogue-quote mapping must never touch the tag.
- **Model non-compliance**: if the format is not followed, fall back to the single-bubble behaviour. Measure the tag-follow rate before enabling broadly.
- **Beat-plan filter**: compatible (`【name】` only collides if a cast member is literally named `本…`); the filter's prefix rule already passes unknown `【…】`.
- **Cost/latency/quota**: unchanged — one call per turn.

---

## 7. Decisions needed

- **D1 — target feature**: confirm this is roleplay (`RoleplayPage`, bubble chat), not the text-adventure (`WenyouPage`, prose + choices).
- **D2 — what "first message streams" means**: **O1** opening typewriter over authored, tagged text / **O2** AI-generated opening / some other reading.
- **D3 — which 1–2 scenarios** from §5.

---

## 8. Phased checklist

| Phase | Work | Output |
|---|---|---|
| 0 | Research (this doc) | ✅ |
| 1 | `SCENARIO_CAST` + `buildMulticastBlock` + `roleplayCast.ts` + unit tests | parser and prompt land, invisible to users |
| 2 | Per-speaker bubble rendering + name labels + avatars | visible feature, behind the cast flag |
| 3 | Tagged openings + typed-in reveal | "first message streams" |
| 4 | Deploy to :3001, real-device verify, measure tag-follow rate | enable broadly |

---

<a id="zh"></a>

# 多角色剧情扮演方案（多说话人回合 · 逐角色气泡 · 开场流式）

> 状态：**调研稿，未改任何代码**；需要拍板三件事（见 §7）
> 范围：小愈剧情扮演——`api/services/roleplay.ts`、`api/routes/roleplay.ts`、`src/components/RoleplayPage.tsx`、`roleplaySessions`
> 相关：`docs/roleplay-immersion-plan.md` §4.1（那里就把「多角色切分」列为 S1 最难的一项）、`docs/roleplay-bgm-plan.md`
> 英文在前，中文原文见下。

---

## 1. 结论先说（TL;DR）

1. **多角色不是一套新的生成管线。** 剧情 system prompt **本来就允许**模型一次演多人——`_COMMON_RULES_TEXT_ZH` 第 8 条（「合理安排每个角色的出场时间和顺序……可以一次扮演一人或多人对话」）与 `CLASSIC_RULES_TEXT_ZH` §二「NPC 调度规则」。**真正缺的只有两件**：(a) 「谁在说」的标记协议；(b) 按说话人拆分的气泡渲染。
2. **流式基建已经完整。** `?stream=1` 的 SSE（delta / queue / meta / continue / rewrite / done）+ `roleplayChatStream` 已能逐 token 撒进一个气泡。
3. **推荐 A 路线**：**一次流式调用**，每个说话人的段落以 `【名字】` 开头，前端解析成段。成本与延迟仍是 **1×**，下游所有吃文本的环节都不动。
4. **逐气泡流式在 delta 链路上不需要改服务端。** 前端本来就是「每一帧拿到累积全文再重渲染」（`RoleplayPage.tsx:1960-1966`：`full += delta`），所以一个「流式容错」的解析器可以实时拆段——A 角色的气泡先长出来，`【B】` 一到 B 的气泡再出现、再长。
5. **开场白目前是静态的。** `openingAssistant` 是作者写死的数据，由 `pickInitialMessages`（`src/lib/rpInitialMessages.ts`）整段注入 → 瞬间全出。要让「第一条信息是流式的」，走 **O1**（给开场白也写标记 + 前端打字机，便宜、推荐）或 **O2**（开场白改由 AI 生成，动态但要耗一条额度、且在进入剧情这一最脆弱的位置新增了一条生成失败路径）。
6. **额外收益**：显式的说话人标记顺带解掉 S1-c（多角色配音切分）——`roleplay-immersion-plan.md` §4.1 里被称为「本层最难的点」的那条。

---

## 2. 现状盘点（能复用的，别重复造）

| 能力 | 位置 | 状态 |
|---|---|---|
| SSE 流式传输 | `api/routes/roleplay.ts:397-489`（`?stream=1`） | ✅ delta/queue/meta/continue/rewrite/done |
| 流式客户端 | `src/services/api.ts:1504` `roleplayChatStream` | ✅ |
| 每帧累积全文 | `src/components/RoleplayPage.tsx:1960-1966` | ✅ |
| 文本分词（旁白/对白/心声） | `src/lib/roleplayText.ts` `parseRoleplayText` | ✅ **但没有说话人维度** |
| 富文本渲染 | `src/components/RoleplayRichText.tsx` | ✅ |
| 提示词**已允许**多角色 | `roleplay.ts:51` 第 8 条；`roleplay.ts:137` §二 | ✅（只是没标注） |
| 开场白注入 | `src/lib/rpInitialMessages.ts` | ⚠️ 静态、瞬出 |
| `【…】` 前缀流式过滤器 | `src/lib/beatPlan.ts`（`【本拍】`/`[BEAT]`） | ✅ 与 `【名字】` 兼容 |
| 角色名册先例（同仓） | `src/wenyou/engine/types.ts` `CastDraft/CastMember`、`src/wenyou/ui/castHighlight.ts` | 正文内联高亮，**不是**气泡 |
| 剧本侧表写法 | `roleplay.ts:409` `SCENARIO_AUDIENCE`、`roleplay.ts:442` `SCENARIO_TAGS` | 照抄给 cast |

---

## 3. 三条技术路线

| | A · 说话人标记协议 **（推荐）** | B · JSON 结构化输出 | C · 每个角色一次调用 |
|---|---|---|---|
| 形态 | 一次流式调用，每段以 `【名字】` 开头 | 返回 `[{speaker,text}]` | 每回合每个角色各调一次 |
| 成本/延迟 | 1×（不变） | 1× | **N×**（还要串行） |
| 逐气泡流式 | 天然（解析实时文本即可） | 差（得缓冲/半解析 JSON） | 天然 |
| 回归风险 | 低（只加一个解析器 + 一段提示词） | **高**——引号归一、一拍计划剥离、反重复、自动续写、重复闸、安全兜底、会话落盘、长图分享、TTS 全部踩到 | 高——额度模型要重做；同一回合内角色互相看不到台词 |
| 结论 | **做这个** | 不做 | 不做（至少试水阶段不做） |

---

## 4. 推荐方案（A）落地细节

### 4.1 数据
在现有两张侧表旁边加一张同形状的表（与 `SCENARIO_AUDIENCE` / `SCENARIO_TAGS` 同一套路）：

```ts
interface CastMember { id: string; zh: string; en: string; avatar?: string }
const SCENARIO_CAST: Record<string, CastMember[]> = { /* ... */ };
```

`cast.length >= 2` 即对该剧本开启多角色。通过 `flatScenario()` 与前端类型 `RoleplayScenarioInfo`（`src/services/api.ts:1398-1403`）下发为已本地化的 `cast?: { id; name; avatar? }[]`。

### 4.2 提示词
在 `api/services/roleplay.ts` 新增 `buildMulticastBlock(lang, cast)`，由 `composeRoleplaySystem` 注入到「规则」与「任务指令」之间（这个顺序已被单测钉死）。内容：每段必须以 `【名字】` 开头；只允许名单里的角色开口；旁白可以不带标记（中性）；不许凭空造无名说话人；一轮 1–3 个说话人；标记里的名字不许改写/翻译。消融开关 `RP_MULTICAST=0`（沿用项目既有约定）。

### 4.3 解析
新增纯函数模块 `src/lib/roleplayCast.ts`：
`parseCastSegments(text, castNames): { speaker: string | null; text: string }[]`
- 只认「行首 `【名字】` 且名字在名单里」；
- **流式容错**：结尾未闭合的 `【…` 一律扣住不渲染，绝不能当旁白吐出来；
- 认不出的 `【…】` 原样当正文（绝不吞字符）；
- 幂等、逐字不丢（沿用 `roleplayText.ts` 那三条硬约束）；
- 与 `test/unit/roleplayText.test.ts` 同处补单测。

### 4.4 渲染
`RoleplayPage` 里，当剧本有 cast **且**解析结果至少有一个说话人时，把一条 assistant 消息渲染成「一段一个气泡」：说话人气泡带头像 + 名字标签，旁白气泡无名字、视觉更安静。**否则完全保持今天单气泡的行为**（兜底）。没有 `avatar` 时回退到「名字首字」圆形色块。

### 4.5 流式
**delta 链路不需要改服务端。** 前端继续累积带标记的全文、每帧重解析；收尾仍由 `done.reply` 覆盖。重新生成 / 编辑重发 / 版本切换 / 重复闸 / 会话落盘，全部继续作用在「整条带标记的回合」上。

*可选加固*：额外发一个 `{type:'speaker'}` SSE 事件，让气泡边界在「标记被拆到两个 delta」时也干脆——v1 不做也行。

### 4.6 开场白（「第一条信息流式」）
- **O1（推荐）**：把改造的那一两部剧本的 `openingAssistant` 也用 `【名字】` 写好，进入**新会话**时用前端打字机逐段揭示。零 AI 成本、确定性、不新增失败路径。
- **O2**：进剧情时由 AI 生成开场白（需要一条「不需要用户消息」的新模式，或一条隐藏的合成回合），像正常回复那样流式。动态，但要耗额度、增加进入延迟，并在今天唯一没有生成失败的入口位置新开一条失败路径。

---

## 5. 候选剧本

按现有点赞数与「设定里本来就存在第二个角色」的天然程度排序。

| 剧本 id | 标题 | 主角色 | 天然可加的配角 |
|---|---|---|---|
| `lutingyuan-shenyan` | 冷峻刑警的年下法医 | 陆庭深 | 搭档刑警 / 嫌疑人 / 法医室同事 |
| `shenshu-jiangjia` | 乖乖，别抛弃我 | 沈殊 | 经纪人 / 情敌 / 家族长辈 |
| `guyushen-songzhi` | 他等了我十五年 | 顾聿深 | 朋友 / 司机 / 生意对手 |
| `peixiuyuan-linwantang` | 替姐出嫁那夜 | 裴修远 | 姐姐 / 婆母 / 侍女 |
| `shenqingyi-luchi` | 高冷女总裁的落魄助理 | 沈清漪 | 副总 / 同事 / 债主 |
| `guwanqing-heyu` | 傲娇大小姐 | 顾晚晴 | 情敌 / 管家 |

---

## 6. 风险与回归面

- **所有吃原始 `content` 的地方都要过一遍**：长图分享（`StoryShareModal`）、TTS（`src/lib/storyVoice.ts`）、会话落盘、反重复（`collectAvoidPhrases`）、输出安全（`checkAiOutputSafety`）、繁中转换（`normalizeRplangText`）。标记对安全无害，但分享/TTS/反重复必须先把标记剃掉，否则 `【陆庭深】` 会印进分享长图、也会被念出来。
- **专名保护**：`protectedNames` 必须包含全部 cast 名字，否则繁中转换可能改到标记。
- **引号归一**：分语言的对话引号映射绝不能碰到标记。
- **模型不遵守**：格式没照做就回退单气泡。铺开之前先量「标记遵循率」。
- **一拍计划过滤器**：兼容（只有角色名以「本」开头才会撞；过滤器对认不出的 `【…】` 本来就走放行）。
- **成本/延迟/额度**：不变——一回合一次调用。

---

## 7. 需要拍板的三件事

- **D1 目标功能**：确认是剧情扮演（`RoleplayPage`，气泡对话），不是 AI 文游（`WenyouPage`，卷文 + 选项）。
- **D2「第一条信息流式」具体指**：**O1** 开场白打字机（写死文本 + 逐段揭示）/ **O2** 开场白改 AI 生成 / 还是别的意思。
- **D3 先改哪 1–2 部剧本**：从 §5 里挑。

---

## 8. 分期清单

| 阶段 | 工作 | 产出 |
|---|---|---|
| 0 | 调研（本文档） | ✅ |
| 1 | `SCENARIO_CAST` + `buildMulticastBlock` + `roleplayCast.ts` + 单测 | 解析与提示词就位，对用户不可见 |
| 2 | 逐角色气泡渲染 + 名字标签 + 头像 | 功能可见，按 cast 开关生效 |
| 3 | 带标记的开场白 + 打字机揭示 | 「第一条信息流式」 |
| 4 | 部署到 :3001、真机验证、量标记遵循率 | 再考虑全量铺开 |
