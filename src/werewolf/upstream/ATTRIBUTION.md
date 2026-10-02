# 第三方来源署名（AI 狼人杀）

本目录下的「AI 狼人杀」玩法**移植**了开源项目 **wolfcha** 的部分功能设计与规则实现。

## 来源

| 项 | 值 |
|---|---|
| 项目 | wolfcha（猹杀） |
| 仓库 | https://github.com/oil-oil/wolfcha |
| 许可 | **Apache License 2.0**（全文见同目录 `upstream/LICENSE`） |
| 移植时对应的版本 | `main` @ `78b4a58c6624fac16d78c17b1fdd2a199076d41e`（2026-09-13） |
| 核实方式 | `temp/verify-werewolf-licenses.mts`（GitHub API `license.spdx_id` + LICENSE 原文交叉验证） |

## 许可义务的落实情况

- **保留许可与版权声明**：Apache-2.0 全文原样保留在 `upstream/LICENSE`（未修改）。
- **NOTICE 文件**：已核实上游仓库内**不存在** `NOTICE` / `NOTICE.md` / `NOTICE.txt`（三种命名均 404），
  因此 Apache-2.0 §4(d) 的 NOTICE 传播义务**不触发**。本文件是**我们自己的**来源说明，不是上游 NOTICE 的替代或搬运。
- **标注修改**：见下方「我们做了什么改动」。
- **商标**：Apache-2.0 §6 **不授予商标权**。因此本项目**不使用**「Wolfcha」「猹杀」名称、logo 或任何品牌素材；
  对外使用小愈自己的玩法名，把「狼人杀」仅作为玩法类型描述。
- **未移植的部分**：上游的 Supabase 鉴权、tokenpay / Watcha 支付、OAuth、转介绍与福利 campaign、
  以及其 Next.js 应用外壳**一律未移植**，本玩法使用小愈自己的账号体系（`api/services/accounts.ts`）与
  自己的模型密钥通道（`api/services/deepseek.ts`，服务端持有）。

## 我们做了什么改动（Apache-2.0 §4(b) 要求标注）

移植方式是**功能移植 + 重写实现**，不是文件搬运。原因：上游的状态真相是**客户端**（jotai atom + `localStorage`，
见其 `src/store/game-machine.ts`），而小愈要求**服务端权威**（视角隔离、点数结算、运营端统计都在服务端）。

| 上游 | 我们 |
|---|---|
| jotai atom + localStorage 客户端状态机 | `src/werewolf/engine/` 纯函数状态机（服务端权威） |
| `GamePhase` 类继承 + `PhaseManager` | `tickOnce()` / `runSystemSteps()` / `actorsNeeded()` |
| 状态即真相、客户端可信 | `view.ts` 按视角过滤后才下发；AI 与真人共用同一套过滤 |
| 事件为自然语言文本 | 事件只存结构化参数（`seat`/`target`/`role`），三语文案在前端渲染 |
| 身份配置表 `src/lib/role-configuration.ts`（8/9/10/11/12 人） | 移植其配比（含白狼王/守卫/白痴），**另加我们自己的 6 人快速局** |
| 阶段序（守卫→狼→女巫→预言家→结算） | 沿用其阶段序 |
| 「结算 ≠ 公布」、票型结算后才进他人上下文等规则 | 移植其规则意图，并在我们的引擎里重写与单测 |

## 逐项来源

| 功能 | 来源 | 我们的实现位置 |
|---|---|---|
| 身份配比（8/9/10/11/12 人，含白狼王/守卫/白痴） | `src/lib/role-configuration.ts` | `engine/types.ts` 的 `ROSTERS` |
| 夜晚阶段序：守卫 → 狼人 → 女巫 → 预言家 → 结算 | `src/types/game.ts` 的 `Phase` 枚举 | `engine/rules.ts` |
| 「结算 ≠ 公布」（夜间结果算出来 ≠ 可以公布） | `src/lib/night-visibility.ts` | 事件 `audience` 机制 + `resolveNight` |
| 「进行中的投票不能进入其他投票者的上下文」 | `src/lib/vote-rounds.ts` | `applyVote` 不公开 + `resolveVote` 结算时补写 |
| 发言顺序状态 | `src/lib/speech-order.ts` | `speakOrder` / `speakIndex` |
| DeepSeek 前缀缓存稳定前缀 | `src/lib/deepseek-prompt-scope.ts` | `ai/prompt.ts`（见下） |
| 白狼王自爆 / 守卫 / 白痴 / PK 加赛 / 遗言 / 警长竞选 | `src/game/phases/*`、`src/types/game.ts` | `engine/rules.ts`（按我们的状态机重写） |

> 说明：本表会随移植推进持续更新。**每一行的状态以对应单测为准**，「写了」不等于「验过」。
