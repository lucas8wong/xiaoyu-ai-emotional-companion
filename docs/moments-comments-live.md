# Real-model character life checks and user stickers

The 2026-10-25 follow-up adds private Moments comments and a shared local sticker
picker for chat/comments. The comment menu uses the familiar adjacent Like/Comment
actions, a flat tinted thread with named replies, a bottom composer and a docked
sticker panel. This is a Xiaoyu interface inspired by familiar messaging patterns.

## Data and execution

User comments save before any model response. Text, sticker-only and combined
comments are supported, as are replies to an existing visible comment, own-comment
deletion, earlier-page loading and explicit retry after a failed character reply.
The current authenticated owner and published post are required for every action.
Cross-post reply IDs, forged sticker IDs, unsafe content and overlong text reject.
An owner-scoped request ID makes uncertain sends replay the original operation;
reuse with different contents rejects. Deleting a parent hides its descendants,
stops queued replies and retains the historical record internally. Deleted text is
excluded from model context. Character comments cannot be deleted as user comments.

Comments remain in the existing `shop-moments.json` value, on `post.comments`:
`id`, `author`, `authorName`, `text`, `at`, optional `sticker`, `replyToId`,
`clientRequestId`, `deletedAt`, `replyState`, `replyAttempts` and `retryAt`.
Read APIs omit private replay/attempt fields and paginate 50 visible comments.
The full stored list is never trimmed. Original post fields/likes remain intact.

Successful comment creation nudges the production background worker, independently
of whether the feed stays open. Author replies use current persona/relationship,
the post, bounded comment context and current enabled memory. Source versions,
deletion and ownership are checked after asynchronous work. Failures store a state
and retry time, never substitute prose. Automatic replies have up to three attempts,
explicit retry at most five total; at most 20 comments per owner/day receive an
automatic reply. User sends are limited to six/minute and 30/hour. Pending/failed
work survives restart. Existing gift priority and ordinary pacing remain.
Actual character replies contribute to saved unread activity. Visible pending
threads poll every three seconds; general feed polling remains once/minute.

## Manual and automatic stickers

`GET /api/stickers/library` exposes only deployed image IDs, dimensions, alt,
first-party URLs, family and scene tags, without source repositories/manifests or
filesystem paths. Eight series, 27 scenes, current-pack search and static thumbnails
give a small familiar picker. Existing Unicode emoji and chat online search remain.
Images load lazily; animated media keeps explicit play/pause and reduced-motion
support. Selecting a local sticker sends it directly, preserving an unsent chat
text draft. The server resolves the ID to canonical metadata. A sticker is an
attachment, not a base64 photograph, and is not charged as an image upload.

Manual user choices have no automatic-character sampling limit. Character reactions
retain their previous low frequency, relationship/era/safety gates and repeat limits.
The model receives only a bounded picture description for user-sticker meaning;
URLs and image bytes are not added to chat prompts. Semantic selection now sends
only bounded persona fields, not avatars or full story cards. Ordinary “send a
reaction” wording also reaches the explicit-request gate. No new browser persistence,
store, dependency or external scheduler is introduced.

## Findings from real calls

Tests use fictional isolated accounts and actual configured DeepSeek requests,
without replacing model prose or responses. Cases include a warm lover, reserved
friend, playful buddy and older-sister relation. The first pass exposed:

- Unsupported “I have no stickers” copy and missed ordinary reaction requests.
- A raw `sage` color code, and a newly received gift described as worn earlier.
- A user's pet/experience transferred into the character's own daily life.
- An invented shared childhood recollection and literal interpretation of an image.

Fixes add capability/attribution rules, localized color names and elapsed gift age,
plus a fail-closed semantic attribution reviewer before background post persistence.
The reviewer allows related creative interests, but rejects owner transfers and
unsupported shared events. No failed/rejected generation becomes a business post.
Real positive/negative probes confirmed rejection of a user's cat moved into the
character's editing room, while allowing an explicitly attributed creative idea.
That guard rejected an actual otherwise-plausible generated cat post.

Real follow-up calls produced distinct sleepy Nailong, restrained cat, opossum and
lying-down penguin reactions; ordinary low-frequency gates remain. The corrected
immediate gift branch produced a saved post in about 1.8 seconds in one observed
run; this is a test observation, not a production latency guarantee. A corrected
family reply asks about the childhood scarf instead of pretending to remember it.
One real sticker-comment attempt failed safely and succeeded on retry. Likes enter
actual subsequent generation as bounded preferences/examples; this small sample
does not establish a guaranteed topic or long-term effect.

All test accounts, conversations, receipts, model usage and development cost records
are isolated under ignored `temp/moments-comments-20261025/`; real usage is recorded,
synthetic unit usage is not counted as spend. Some publication due times are advanced
inside isolated tests; no production activity or timestamps are fabricated.
Screenshots use actual components, saved real-model text and the approved media.
Physical devices, speech readers, exhaustive model-quality evaluation and installed
APK updates remain outside the verified scope. Restore and release evidence belongs
in CHANGELOG and the cloud continuity inventory.

<a id="zh"></a>

# 真实模型验证、朋友圈评论与用户表情

评论采用点赞／评论相邻操作、浅底平铺评论、蓝色姓名及「回复某人」、底部输入和分类表情面板。
支持文字、纯表情、组合评论、回复指定评论、删除自己的评论、查看更早评论及失败重试。
先保存用户内容，角色回复另排队；同请求编号重试不重复，异主／跨帖／未发布／伪造素材均拒绝。
删除保留内部历史并隐藏整条回复链，删除内容不进模型，进行中的回复也不会复活它。
沿用shop-moments.json，新增评论列表及上述可选字段，完整迁移、不裁剪历史；每页展示50条。

角色评论遵守当前人设／关系与有效记忆，生成后再核对归属和记忆版本；失败仅有状态和重试。
自动最多3次尝试、手动最多5次，每用户每天最多20条评论安排自动回复；用户发送6条／分钟、
30条／小时。生产后台处理，真实角色回复计未读，待回复时可见页面每3秒轻轮询，普通轮询仍1分钟。

聊天和评论共用8系列／27场景表情，可在系列内搜索；缩略图静态懒加载，动图支持暂停和减少动画。
选择直接发送，聊天未发的文字草稿保留。服务端只收素材ID并解析为规范附件，不转普通照片；
用户手动选择不套角色自动采样，角色仍保留低频／防重复／关系／安全门槛。原emoji和聊天在线搜索保留。
无新数据库、浏览器持久化、依赖或外部服务，部署素材清单仍私有。

真实DeepSeek调用覆盖恋人、克制朋友、抽象损友及姐姐；发现并修复「没有表情包」、颜色代码、
刚收礼却称更早用过、挪用用户宠物／经历、附会共同童年等问题。后台动态增加语义归属复核，
宁可延后也不发布归属错误；真实正反例已验。修后实际选出奶龙、猫图、负鼠及企鹅，
一轮即时送礼约1.8秒保存动态；这只是样本观察，不保证生产延迟。真实纯表情评论曾安全失败，重试成功。
点赞偏好进入实际下一轮选题提示，但小样本不能证明长期效果或保证某题材。

所有账号、对话、礼物、用量与费用隔离于上述temp目录，未伪造模型正文；部分到期日程在隔离测试中提前触发。
截图为真实组件和实际模型输出，未修改生产记录；未验实体设备／读屏／穷尽文笔表现，也不代表已更新APK。
