# Character stickers in daily chat and Moments

Update: user-selectable local packs and Moments comments now use canonical sticker
IDs through the shared picker. The deployment-only image metadata is available at
`/api/stickers/library`; source manifests and filesystem paths remain private.
Both user and assistant attachments persist independently of text. Manual user
choices are distinct from low-frequency character reactions. Real-model follow-up,
comments, ownership checks and migration fields: [comments contract](moments-comments-live.md).

Enabled by the operator's explicit request on 2026-10-25. The 372-image private
bundle is now used by `api/services/characterStickers.ts`, independently of the
retired public catalog/search helper. This is operational approval to use the
selected media in Xiaoyu; it does **not** represent verified third-party IP rights.
Source/license uncertainty remains recorded in the original collection manifest.
No third-party image or production data is committed to public Git.

## Selection and pacing

Selection happens after successful text generation and safety validation. It uses
the user's current message, the completed response, actual character voice/identity/
boundaries, effective relationship and that owner's retained character history.
After the low-frequency gates, a semantic auxiliary call judges intent, negation,
tone, persona and relationships against at most 48 balanced local descriptions.
It has 96 output tokens and a 2.5-second deadline; invalid/unknown IDs or uncertainty
mean text only. Actual auxiliary usage is metered, without debiting user energy.
No fake "sent a sticker" text is inserted. Empty/failed replies cannot create attachments.

- Meaning selects the picture, rather than keyword/category lookup. The model can
  decline even after a sampled opportunity and can understand an implicit sleepy
  remark without needing the word "goodnight". Candidate descriptions are data,
  never instructions; no URL or invented asset ID can be returned.
- Gentle roles favor natural cute expression; playful roles may use abstract humor
  only when the atmosphere fits. Reserved roles exclude abstract categories and
  sample less often. Character-family affinity and balanced scene/family coverage
  limit domination by the largest source; the final semantic decision follows the
  actual voice, boundaries, recent conversation and current relationship.
- Romantic pictures require the lover relationship; gifts do not imply a relationship
  upgrade. Explicit no-sticker requests and character boundaries suppress use.
  Recent saved user opt-outs remain respected across character sessions until a
  later sticker-related request changes that recent conversational preference.
- Skip crisis/grief/serious distress, modern memes in an ancient in-story setting,
  other media, search-result answers and adult handoff responses. Out-of-story
  daily chat can use modern images. All existing content safety rules remain.
- Chat: the first three ordinary assistant turns stay text-only; eligible later
  turns have 9% (reserved), 15% (default/gentle) or 22% (playful) sampling chance.
  An explicit request can bypass warmup/sampling, never cooldown/repeat/boundaries.
  At least five intervening assistant turns AND 12 minutes after the last sticker;
  maximum three per rolling hour and twelve per rolling day. Character-scoped
  history crosses sessions but never crosses owners. It uses retained history,
  not a new frequency database; deleting all that character history resets it.
- Moments: 24% chance only for matching posts; at least two intervening character
  posts AND 18 hours since that character's last sticker, with at least three
  intervening posts across the owner's feed. A generated batch also respects this
  spacing. No extra gift image and sticker together. Recently sent 24 IDs are excluded.

## Storage, transport and rendering

A typed optional `sticker` object (immutable ID/version/local URLs/alt/dimensions/
animated flag) lives on the existing assistant message or Moments post. Text and
historical records stay unchanged. Conversation archives retain the entire object.
JSON chat, SSE done, idempotent generation replay, network recovery and paged history
all return it. Split-bubble restoration attaches it **once, on the last bubble**.
Live streaming attaches before cancellation invalidates its generation ID.

`CharacterStickerImage` renders beneath the spoken reply/post, with meaningful alt,
reserved aspect ratio and compact 144px width. Animated images have native 44px
play/pause controls; reduced-motion users get the static poster by default.
Keyboard activation, language, dark skin and RTL use existing application systems.
If animation loading fails, try its poster; if media is unavailable, retain the
spoken text without inventing a fallback business message. Reload can retry media.

`GET /api/stickers/local/:filename` serves only reviewed, deployment-enabled files
from the fixed private bundle with immutable caching and nosniff. It cannot fetch
remote URLs, traverse directories, expose a full private catalog or read user files.
These are common product images, not private user attachments; access is public
for ordinary browser image loading, with no auth token in an image URL.
The full source collection and ZIP remain outside public static directories/Git.

## Deployment and continuity

The default root is `resources/stickers-modern/2026-10-25/`; optional
`CHARACTER_STICKER_ROOT` supports an explicitly provisioned persistent resource path.
The matching private `runtime-approval.json` must have `allowInApp: true`, the exact
manifest version and the approved ID list. Only listed, existing, curated scene
files and posters are eligible. Missing/invalid configuration or missing files yields
text-only replies. Set `CHARACTER_STICKERS_ENABLED=0` to stop new selection while
retaining historical media serving. Do not delete immutable files used by history.

Migration must include the complete private bundle **and runtime-approval.json**,
all original source notices and exact backend/frontend sources. Compare hashes,
fetch a primary image and poster, then restore-check chat/Moments attachments and
cooldowns. No new SQLite key/browser store/dependency/service; optional attachment
fields belong to existing sessions, chat archive chunks and shop-moments.json.
Backups must preserve those full values. A website release does not update an
already installed APK. No automatic cloud upload/off-host backup is claimed.

## Verification

Evidence is private in `temp/sticker-integration/`. Synthetic tests isolate file
stores/accounts and model responses; no paid external call or real conversation is
used in screenshots. 51 targeted checks cover selection/relationship/frequency,
JSON/SSE/replay/history/owner isolation, Moments persistence/likes/failure, path
allowlisting and existing chat/Moments regressions; the explicit deployment-allowlist
change additionally passes 13 relevant checks. Cache contract: 184 passing checks.
Browser tests use actual ChatPage/ShopMoments and real isolated Express routes with
the selected real media: three languages × 320/390/1280px × two surfaces = 18 layouts,
plus dark, keyboard playback, reduced motion, RTL/double CSS zoom, missing-image
text retention and reload recovery. No overflow in the 18 layouts; sticker regions
fit RTL/zoom. No application page exceptions in measured flows. Phone/dark captures
are inspected. Physical devices, speech screen readers and full accessibility audit
are not verified. Final build/restart/health evidence is recorded in CHANGELOG.

<a id="zh"></a>

# 角色日常聊天与朋友圈表情

按用户2026-10-25明确要求启用。角色先正常完成文字回复并过安全校验，再用实际人设、口吻、
边界、关系及当前语义决定。低频门槛后最多48候选交给辅助模型判断，96输出token／2.5秒上限；
理解反讽、否定与隐含情绪，不按关键词直接配图；不确定／超时／未知ID就纯文字。
按真实用量登记辅助成本，不扣用户元气，不强迫每轮配图。
温柔系偏可爱，活泼系可抽象，克制系较少且不整活；恋爱图片只给恋人关系，送礼不自动升级关系。
危机／哀伤／严重困扰、古代入戏、别发表情的意愿、其他媒体与搜索答案等不配梗图。

聊天前三轮普通回复不用表情；后续符合场景时约9%／15%／22%概率，再受6轮与12分钟双冷却、
滚动每小时3张／每天12张限制。朋友圈符合场景才约24%概率，同角色至少隔两条无图动态和18小时，
整份动态至少隔三条，近期24张不重复。实际频率会低于采样概率，没有合适素材就纯文字。
频率依据该用户该角色保留记录，不混用其他用户；删除该角色全部历史也会重置依据。

附件与正文分开保存在原会话／归档／动态里；实时回复、断线恢复、幂等重放、历史分页、刷新和点赞
均保留，分段只在最后一条出现一次。动图可键盘播放／暂停，减少动画默认封面，图坏不写假台词。
同站只开放配置名单中的不可变图片，图地址不带用户令牌，第三方IP授权状态不伪造为已核实。
素材与启用清单私存，不推公共仓库；明确的站内启用要求不等同于第三方版权证明。

迁移携带完整私有目录及runtime-approval.json和准确源码，核对哈希／静图／动图封面及恢复后的附件；
无新用户键、浏览器存储、服务或依赖。不代表已上云／异机备份，也不会自动更新已安装APK。
专项51项、额外名单13项、缓存184项及真实组件18组三语三宽等检查见英文与CHANGELOG；
截图为隔离合成对话／动态，未使用真实用户内容或付费模型，未验实体设备／读屏语音／完整可访问性审计。
