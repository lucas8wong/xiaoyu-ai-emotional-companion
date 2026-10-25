# Character life, memory and background Moments

This contract replaces lazy generation on feed visits. The application server is
the only writer. Reading, refreshing and unread polling never call a model.
The server scans saved plans every 30 seconds, processes up to two due owners per
cycle, prioritizes gifts, and coalesces concurrent work for each owner. The timer
starts only in production; `SHOP_MOMENTS_BACKGROUND=0` disables new background work.
`SHOP_MOMENTS_TICK_MS` may set a bounded 10–300 second interval.

## Memory and interests

Use only the latest nonempty conversation archive for that owner and character.
Current enabled/corrected summaries and durable saved interests, plus up to ten
recent safe messages, are bounded evidence in the changing prompt tail. Parallel
conversation worlds and other owners/characters cannot contribute. Respect memory
corrections, disabled entries, deletion recall barriers and superseded facts;
exclude sensitive information and long verbatim user quotations. No invented
real-world meeting, promise, delivery, or current-day fact may be inferred.
Source revisions are checked again after generation/semantic selection. Pending
drafts recheck before release; stale drafts remain archived as withdrawn and are
never displayed. Existing published history is retained.

Actual retained likes supply topic/style weights and up to three liked examples.
The model can infer concrete interests from those examples without copying them.
Own-character likes carry weight 1; this owner's other-character likes carry 0.2.
Weights decay with a 21-day time constant, expire after 90 days, and add at most
2 to a topic's baseline weight of 1. Novelty and recent-topic avoidance remain.
Unlike removes its influence immediately; repeated toggling creates no accumulated
score. The bounded hints also reach the existing later SYSTEM chat context.
Character identity, independence and relationship limits take precedence.

## Publication and gifts

Recent chat activity, the feed or status establishes a seven-day active window.
Startup recovers owners with recent saved conversations. New ordinary plans begin
2–11 minutes later. Subsequent intervals vary around 3–6 hours, batches vary from
1–4, ordinary publication is capped at six per owner/day, and an author appears at
most once/day in that ordinary schedule. Ordinary work sleeps between 01:00 and
07:59 in the user's saved timezone. A real absence is allowed; opening is never a
promise of an update. Up to three batch posts publish immediately; other drafts
are released after 2–45 minutes, with current evidence checked again. Publishing
uses actual completion/release time, never invented historical timestamps.

Both purchase-and-send and sending held inventory emit only after the gift commits.
Each true gift creates an idempotent, persistent priority opportunity: 20% are due
immediately, the rest within roughly 1–5 minutes, plus model/queue time. A task that
would cross local midnight is due immediately. These are opportunities, not a
guaranteed upstream response time. Same-character pending gifts merge; after a gift
post, another waits at least ten minutes. A six gift-post/day ceiling prevents
spam; further gifts remain queued. Overnight gifts may respond. The required gift
ID/product/color is resolved from the current owner's authoritative gift journal,
not model invention. The response reflects the actual object and timestamp, with
no price comparison, request for more spending or promise of affection.

Every cycle reconciles the last 24 hours of authoritative gift deliveries to
recover an interrupted event. Saved pending tasks survive restart. Failures use
bounded retry delays and never create substitute business messages or phantom
posts; a failed save does not expose a result. Previously published gift IDs
prevent repeat processing. Account deletion stops late publication.

## Semantics, costs and continuity

Sticker frequency, safety, relationship, era and repeat gates run before a semantic
auxiliary judgment. The model receives at most 48 balanced local descriptions,
recent intent and final text. It may decline even after sampling. Allowlisted IDs
only; 2.5-second timeout, 96 output tokens, invalid/unknown results produce text
only. No keyword selects an image. Existing chat/Moments cooldowns remain in
[the sticker contract](character-stickers.md). Calls are auxiliary, metered at real
provider usage and do not debit user energy; they can add latency and API expense.
No paid prewarming or production-user content is used for test fixtures.

No new database, browser persistence, dependency, external scheduler or notification
service. Preserve the **whole** `shop-moments.json` SQLite value: optional
`activeUntil`, `lang`, `lastViewedAt`, `pendingGifts` (IDs, timestamps, due times,
attempts), and post `topic`, `style`, `giftIds`, `memoryVersion`, `releaseState`.
Preserve all existing posts, likes, future schedules, full gift journal and chat
memory/archive values. Old records initialize seen state from existing visible
posts; there is no launch-time fake unread flood. The UI shows real saved unread
counts, clears on viewing, and polls visible screens every minute. The feed's
one-week/60-item display window does not delete historical records.

Migration includes the exact server/routes/hooks/components and private media
bundle/approval described in the cloud inventory. The dirty public checkout alone
is not the full runtime. Isolated tests stub model output and use synthetic owners;
screenshots show real components and collected media, not proof of live model prose
quality. Release evidence is under ignored `temp/moments-life-20261025` and
`output/playwright/moments-life`. No APK update, off-host backup, automatic cloud
publication, email or push notification is implied.

<a id="zh"></a>

# 角色生活、记忆与后台朋友圈

朋友圈改由生产服务器按保存计划生成，打开／刷新／未读轮询都只读。默认每30秒扫描，
每轮最多处理两位用户，礼物优先，同用户并发合并。普通动态在最近聊天或浏览后的7天活跃期内
运行，新计划2至11分钟后尝试；之后约3至6小时一批、1至4条，每天普通动态最多6条、
同角色普通动态每天一次，按用户时区避开凌晨1至8点。部分草稿延迟2至45分钟发布，
发布前再核对记忆，过期草稿保留记录但不展示，不倒填假时间，也不保证每次打开都有更新。

只读本人同角色最新非空存档的有效／更正记忆、长期兴趣与少量安全对话；不混平行存档，
不把剧情当现实，不引用敏感资料或长段用户原话。已更正／禁用／删除的来源不会从旧原文复活。
真实保留的点赞提供题材权重、表达风格和少量实际内容例子，模型据此理解具体兴趣；
同角色权重1、本人其他角色0.2，21天衰减、90天失效，偏好加权有上限且保留新题材。
取消点赞立即撤回影响，反复切换不刷分；聊天末尾SYSTEM也收到有限提示，人设和关系边界优先。

直接买来送和从私藏送出都在交易成功后排队，20%立即到期，其余约1至5分钟内，另加模型和队列耗时；
快跨当天零点时立即尝试。同角色待发礼物合并，礼物动态之间至少10分钟、每天最多6条，
超出保留排队，失败延后重试。礼物编号／物件／颜色／时间必须来自真实送达记录；
不承诺花钱换感情。重启恢复任务，每轮补查过去24小时已送日志，不重发已处理礼物。

表情先过原低频／关系／安全／时代／防重复门槛，再由模型理解语义决定发不发及选哪张，
最多48候选、96输出token、2.5秒超时，拿不准或错误就纯文字，不按关键词直接配图。
辅助调用记真实成本，不扣用户元气，会增加部分延迟及API费用。

沿用原SQLite库／商店动态键，无新浏览器存储、依赖或外部服务；整份历史、点赞、草稿状态、
记忆版本、待发礼物和日程字段都要随迁移保存。旧动态不制造未读，新未读来自实际已发布记录。
一周／60条是展示窗口，不删除历史。参数、迁移字段及隔离验证限制见英文；不代表已发布APK、
上云、异机备份或邮件／推送。期待感来自连续生活线索与自然节奏，不用假活跃、内疚或亲密度奖惩。
