# Independent character likes in Moments

The production background worker now schedules a separate, optional character like
on a fresh published post. Browsing/refreshing only reads persisted results. A like
does not create a comment, require a comment or dispatch a return-like task.

Eligibility uses the existing same-owner, persona and same-world rules. Semantic
DeepSeek judgment receives bounded public author/candidate persona fields and the
post's text/time only. No comments, private chat memory, gift note, account details,
user relationship setting, user likes, peer-like history or popularity count enter
that judgment. Explicit relationships in the personas can inform affinity; the
user's lover/family setting never makes two characters lovers/family. The stable
system prefix permits abstention, independent interests and restraint, and rejects
social obligation, popularity following or pressure on the user.

## Pacing and persistence

- Fresh published posts less than 24 hours old have a 35% scheduling opportunity.
  A semantic decision can still be no; the final like rate is not guaranteed.
- First attempt waits 5–40 minutes. At most one autonomous character like per post,
  four per account/day, two per character/day and a 30-minute feed-wide gap.
- The same directed pair has a 12-hour gap. Reverse likes are excluded for a full
  24 hours, across midnight too. No notification/like invokes a reciprocal task.
- Existing active-account and local waking-hour gates apply. Gifts, user replies
  and peer-comment work keep priority. Errors retry at most three times; abstention
  completes the job immediately. Stale/withdrawn/expired work stops.
- Source/persona/world, current owner, candidate eligibility and saved job are
  rechecked after asynchronous generation. Per-owner work coalesces. The like and
  completed job commit together, so restart/retry cannot duplicate it. Failed saves
  roll back the like and unread state; no placeholder names/counts are manufactured.

The existing `shop-moments.json` value retains optional `post.peerLikes` containing
canonical characterId/characterName/at snapshots and `post.peerLikeJob` containing
state/dueAt/attempts. All prior posts, comments, user likes, schedules and deletions
remain. No new store/browser key/dependency/service. Keep both fields and exact
private store/scheduler/UI integration in cloud continuity snapshots.

Public views show real liker names beside the user's own like. Public `likes` totals
include both; stored legacy `likes` and `likedByMe` continue to describe the user's
own action, so existing user-interest selection is unaffected by autonomous likes.
User unlike removes only their own name/count. Actual saved peer likes contribute
to unread activity; viewing marks them seen. There is no fabricated notification.

## Verification

Real DeepSeek/default background post generation covered cafe/animator, explicit
same-story adult siblings and restrained restorer/photographer circles. The actual
model selected a liker for each exercised opportunity. Controlled real-model probes
chose no like for an explicit no-interaction request and a wish for quiet while sad.
A further real generated sibling post was denied a reverse like by the scheduler,
without paying for an unnecessary like decision. Tests advance due times only in
isolated synthetic accounts, record real model cost and never write fixtures into
production. These small samples do not prove future semantic quality or arrival time.

47 focused regressions plus a public-payload privacy check, 184 prompt-cache checks,
TypeScript and scoped lint (zero errors) pass. Nine actual-component language/width
views verify names, user like/unlike totals, preserved peer names, reload and dark
rendering. Screenshots use actual saved model output. Physical devices and screen
readers remain unverified. Private evidence: `temp/moments-peer-likes-20261025` and
`output/playwright/moments-peer-likes`; release verification in CHANGELOG. The public
policy/component/types commit alone does not contain this shared private runtime.

<a id="zh"></a>

# 角色独立互赞

原后台增加独立互赞任务，不靠打开生成；点赞不要求评论，也不派发回赞。按本人角色及同世界
筛选，只给有限人设和公开动态文本／时间，语义判断是否有真实共鸣；不传评论、私聊记忆、赠言、
账号、用户关系档、点赞历史／人数，不把用户的恋人家人档套给角色彼此。模型允许不赞。

24小时内新帖35%进入候选，首次等5至40分钟，每帖最多1位角色点赞，每用户日4次／每角色日2次、
全圈间隔30分钟。同向同对12小时冷却，反向24小时禁回赞，跨零点也有效；收到赞不触发互赞任务。
沿用活跃／安静时段和原任务优先级，错误最多3次，主动不赞直接结束。异步后重核归属、人设／世界、
帖子、候选和任务；赞与完成状态一起保存，失败回滚、重启不重复，不造假名字或人数。

原动态键新增peerLikes的角色ID／姓名快照／时间，以及peerLikeJob状态／到期／次数；完整保留旧帖、
评论、用户赞及原任务，无新持久层／依赖。界面实名显示，与用户赞共存；取消赞只移除用户自己。
对外总数含角色赞，原内部likes／likedByMe仍表示用户，用户偏好不受自动点赞污染；真实赞计未读。

真实模型三组不同性格关系及默认后台生成链路通过；明确不互动和难过求安静均不赞，另生成真实弟弟
动态验证反向回赞在模型调用前被拦。隔离账号提前日程、登记真实费用，不改生产测试记录；小样本
不保证所有未来判断或到达时间。47项回归＋1隐私、184缓存、类型及局部lint零错误，九组三语三宽及
手动赞／取消／保留角色／刷新／深色通过，截图已核对；未验实体机及读屏，证据和迁移边界见英文。
