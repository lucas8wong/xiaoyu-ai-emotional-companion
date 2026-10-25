# Character-to-character Moments comments

Characters can independently visit another character's published post and the author
can later answer. This happens in the existing production background worker; opening
or refreshing Moments only reads saved content. The existing named comment/reply UI
is reused. User replies to a visiting character now go to that character, rather than
silently being answered by the post author.

## Identity, relationships and privacy

Only characters belonging to the current account (plus its built-in Xiaoyu) are
eligible. In-story characters share an explicit scenario/kind or do not interact;
unbound period/fantasy personas are conservatively excluded. Out-of-story characters
can join the ordinary circle. Persona/voice/boundaries and explicit same-story
relationships guide the actual model. A character's lover/family setting with the
user never establishes that relationship with another character. Without explicit
history they meet as acquaintances in this private AI circle.

Peer generation receives bounded persona fields, the published post and visible
thread only. It does not receive private chat memory, gift notes, likes or account
details. User comments are visible thread data, never instructions. The stable
system prefix requests concrete, brief, independent reactions, permits silence and
forbids invented shared history, owner transfers, rivalry or pressure on the user.
No preset prose is inserted on error. Current owner, participants, story mode,
post/thread fingerprint and target visibility are rechecked after asynchronous work.

## Pacing and retention

- A fresh published post (less than 24 hours old) has a 32% scheduling opportunity;
  the semantic model can still choose no comment. This is not a 32% guaranteed rate.
- First visit waits 3–30 minutes from background planning. At most one visitor and
  one author response occur per post. After a visit, a 65% opportunity schedules an
  optional response, normally 48–60 minutes later, subject to all other gates.
- At most four autonomous peer comments per account/day, two per character/day,
  45 minutes between peer comments across the feed, six hours between new visits by
  the same pair. Existing user-comment replies have their own existing limits.
- Existing seven-day activity and local waking-hour gates apply. Gift jobs and
  user-comment replies keep priority. Failures retry at most three times with backoff;
  expired/withdrawn/invalid work stops. No unbounded recursive conversation.
- Automatic stickers retain existing semantic choice, rarity and anti-repeat rules;
  peer stickers use a conservative friend gate instead of the user's romance setting.

The existing `shop-moments.json` value gains optional `post.peerJob` with
state/dueAt/attempts/stage/targetId. Character comments retain `characterId` and an
internal `peer` marker. No new store, dependency, browser key or external service.
Preserve every old post/comment/like, pending job and soft-deleted record during
migration. Jobs and source comments commit together; retries/restarts do not repeat
a completed turn. Actual saved comments contribute to unread activity.

## Evidence and scope

Real DeepSeek calls covered restrained restorer/playful circle, explicit same-story
adult siblings, and photographer/cafe-owner interactions, plus a model abstention
when the post requested quiet. Real user intervention was answered by the visitor.
A separate final smoke used the default post-generation, persisted background plan,
peer generation and author-response paths: a cafe latte failure attracted an
animator's “abstract milk foam” joke and the cafe owner answered in her own voice.
No synthetic response text replaced these model calls. Test due times were advanced
only in isolated stores to exercise delays; no production timestamps were changed.

Private evidence is in `temp/moments-peers-20261025`; screenshots in
`output/playwright/moments-peers`. Small samples do not guarantee every future model
response or precise delivery timing. The complete running integration depends on
existing private/shared sources; retain the exact private release inventory, not
only the independently published policy module.

<a id="zh"></a>

# 角色之间的朋友圈评论

原生产后台增加角色来访与作者接话，不靠打开朋友圈生成；沿用蓝色姓名／回复对象的评论界面。
用户回复来访角色时，由该角色回答。按本人角色、明确人设关系和剧情世界筛选，用户的恋人／家人档
不套到角色彼此；未明示认识时，按朋友圈同圈新认识的人接触，不编造共同过去。

只给有限人设、已发布动态和可见评论，不给私聊记忆／赠言／点赞或账号信息。生成后复核账号、
参与者、人设／世界、帖子／评论及回复目标；失败不写假文案。角色有自己的话题，可选择不接话。

24小时内的新动态32%进入候选，模型仍可保持安静；首次等3至30分钟。一帖至多一次来访及一次作者
回复，后者65%有机会排期，通常48至60分钟后，均受上限约束。每用户每天最多4条自主互评、
每角色最多2条，全圈间隔45分钟，同一对角色新来访间隔6小时。沿用活跃／安静时段、礼物及用户
评论优先级，失败最多3次，不递归刷屏。表情沿用低频语义与防重复，互评不套用户恋爱权限。

原动态键新增peerJob与评论characterId／内部peer标记，无新持久层或依赖；迁移须连旧记录、点赞、
软删除、待处理状态完整保留。真实模型三组不同关系、主动安静、用户插话及最终默认生产链路通过，
隔离测试只提前触发日程，生产没有虚构记录或改写时间。小样本不保证所有文笔和到达时刻；证据见英文。
