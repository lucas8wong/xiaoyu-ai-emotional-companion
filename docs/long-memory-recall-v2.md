# Source-linked long-memory recall v2

Status: release verification pending, 2026-10-31. This document describes the first implementation stage, not a promise of lossless memory.

Chat and Story keep their existing memory entrances, original transcripts, verified chapters, facts, edits, prices, membership/input capacities, output defaults and billing. The new path adds local multi-question retrieval, indivisible source groups, one supplementary lexical wave, and a deterministic fifty-turn directory over existing verified chapters. It makes no new inference call and creates no new persistent key, database, dependency, service or browser storage. Generated phase narratives and new paid organization products are not implemented by this release.

## Request path

`archiveRecall.hybridArchiveRecallBlock` calls the shared `conversationRecallController`. Up to six independent question clauses and eight search views retain direct subjects as well as same-conversation user context. Existing lexical and local semantic retrieval remain independent. The semantic index scans once across the supplied views. One supplementary local wave can search unmatched clauses; lexical/semantic similarity is candidate relevance, never a truth or answer-completeness score.

The phase directory groups source-valid chapters into fifty-turn buckets and ranks child chapter/fact text. It only locates bounded original ranges. Every quotation is reread from the current authorized archive; neither the search payload nor phase text supplies quoted bytes. Source revisions are checked after asynchronous work. Directory nodes never become automatic recap rows and never authorize removal of original history. Missing/stale/disabled/corrected sources remain subject to existing exclusion and coverage rules.

Evidence groups retain a bounded original neighbourhood, including question/answer pairs and nearby conditions or changes. Overlap cannot transitively combine the whole history: a group contains at most four original messages. Long messages use complete sentence neighbourhoods, with exact UTF-16 start/end and an explicit partial-message marker when applicable. A single overlong sentence is omitted as a unit rather than character-cut. This is still selective evidence, not a guarantee that every condition in the complete archive was retrieved.

Selection first funds distinct query clauses, then relevant optional groups, within the unchanged evidence and final shared request budgets. Ordinary queries select at most three groups; compound queries at most twelve. Explicit group IDs survive both the wrapper fit and final allocator, so one half cannot be retained after the other half is budget-evicted. Stable source ordering within groups is deterministic. Only final admitted automatic chapter proofs retain their existing original-replacement authority.

Existing current-state and replacement facts continue to distinguish plans from completed events, current holders from historical transfers, user profiles from fiction, and narrator knowledge from actor knowledge. This release does not infer dates from archive positions, rewrite facts, merge independent chats or expand group/private visibility. Pure continuation uses the existing state/continuity path rather than forcing an unrelated archive search. Star-map collection remains separate.

## Isolation, persistence and recovery

Story retains owner/scenario/mode/run scope, then rechecks transcript scope/revision and managed-memory revision before using evidence collected across awaits. Chat retains owner/character/session, memory generation, deletion cutoff and edit guards. Phase chapters are source-validated and chapters intersecting excluded messages are omitted. Stale work cannot renew deleted/corrected evidence.

The directory and query diagnostics are request-local and rebuilt from the current authoritative values. Existing complete SQLite values, source chunks, semantic indexes, memory edits/deletion anchors, jobs and usage/receipts must still migrate intact with the exact code release and ignored assets. No additional durable migration field is introduced. Do not interpret these local derived structures as a new off-host backup.

Set `CONVERSATION_RECALL_V2=0` to return to the preserved prior hybrid retrieval branch. `CONVERSATION_PHASE_INDEX=0` independently disables directory assistance. Existing `ARCHIVE_RECALL` and semantic switches retain their behavior. Runtime configuration changes use the guarded production restart; rollback does not restore an old database, delete indexes or alter stored originals.

Cache-release fingerprinting includes all new recall modules. Stable controls and retained history remain first; dynamic evidence/state stays later SYSTEM data. Existing provider serialization and actual upstream usage/pricing remain authoritative. Additional prompt metadata is counted; no padding or paid prewarming is added.

## Verification and limits

New unit/integration tests cover source ownership, cutoff/exclusion, in-flight rewrite, exact source reread, complete conditions, phase provenance, atomic final fitting and rollback. Actual intercepted production builders cover 120 Story route/preset/JSON-stream combinations and eight Chat combinations; these are wire tests, not live model scores or cache-hit measurements. New tests are included in `npm run test:cache`.

Private reproducible evidence is retained in `temp/long-memory-20261031/`. Forty-eight synthetic conversations each have compound, single-fact and unavailable-fact queries, using 100/300/1000-turn histories. A separate dense-paragraph variant checks the old character-cut failure. Exact evidence presence is not answer correctness. A 10,000-turn/1,000-chapter local replay measures bounded lookup and original preservation. Paid synthetic DeepSeek QA is isolated from production users, balances and feedback; all failed preparation runs and actual usage receipts are retained. These templated fixtures do not certify general quality across languages, providers, real conversations or all privacy edge cases. Final scores, full-suite differences and release-health/SQLite/feedback verification belong in CHANGELOG.

Design inspiration: [billion-context](https://github.com/ranxianglei/billion-context), reviewed at `44067a5bc779f3553c01b30c846762d8bfd9f753`. This implementation uses Xiaoyu's existing source-linked archive and allocator; it does not install or import the proxy/kernel. Direct future source reuse requires reviewing that version's attribution terms.

<a id="zh"></a>

# 来源可追溯的长程记忆召回 v2

状态：2026-10-31，待最终发布核验。本轮是首批后端增强，不承诺无损或永远记住全部内容。

小微信与剧情沿用原记忆入口、原文、已核验章节、事实、修正、价格、会员容量、输出缺省和计费。新增本地多问题检索、完整来源组、最多一次补查，以及基于现有已核验章节的五十回合目录。没有新增模型调用、持久键、数据库、依赖、服务或浏览器存储；生成式阶段正文及新收费整理不在本轮范围。

最多六个问题、八种查询视图，直接主体与本会话用户上下文并行保留。原关键词与本地语义检索仍相互独立，语义索引一次扫描多个视图。目录仅指向原章节与原文，不直接充当事实，更不能授予原文覆盖权限。所有引用重新读取本人当前存档，并在异步后复核版本；停用、删除、纠正、账号／角色／存档／周目边界继续优先。

来源组保留问答、条件与附近变化，单组最多四条原消息，防邻接关系把整个历史连成一组。长消息按完整句群选择，局部摘录明确标记UTF-16位置与非完整消息；超长单句整体取舍，不切断谓语。先照顾不同问题，再按相关性装入既有预算；普通问题最多三组，多问题最多十二组。前置裁量与最终分配均保持来源组完整，候选命中不冒充最终采用或答案正确。

既有状态与替换关系继续保留承诺条件／取消／完成、历史与现持有人、人物所知及虚构／现实边界。本轮不推断日期、不改写事实、不合并独立聊天、不共享私聊、不扩大星图记忆。普通续写沿用当前连续性处理，不强塞旧事搜索。

目录与诊断按请求派生，可重建，无新增需迁移字段；原整库、原文块、语义索引、编辑／删除锚点、任务、费用及使用回执仍须与准确源码和私有资源同版保留。`CONVERSATION_RECALL_V2=0`回旧混合检索，`CONVERSATION_PHASE_INDEX=0`单独停目录；按既有脚本重启配置，不用旧库回滚新数据。缓存指纹涵盖新增模块，固定规则／历史在前、动态记忆保持后部SYSTEM，实际费用以上游为准。

新增测试覆盖来源／归属、删除／时间边界、异步改写、原文重读、条件完整、目录不授覆盖、最终装配原子性及开关回退，接入缓存套件。真实构造器拦截120组剧情与8组聊天，不冒充真实模型或缓存命中实测。私下48份100／300／1000回合合成会话、长段落变体、一万回合性能回放和隔离DeepSeek问答保留全部准备失败与费用；模板样本不能证明全语言／模型／真实会话普遍无损。最终分数、全量旧失败对照、健康／整库／反馈发布结果见CHANGELOG及`temp/long-memory-20261031/`。
