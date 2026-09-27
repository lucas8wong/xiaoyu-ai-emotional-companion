# 小愈（Xiaoyu）单元测试覆盖清单

> 本文档记录本会话为各功能/服务补充的 `node:test` 单元测试，以及验证结果。
> 运行方式：`npm test`（全量 node:test，数据隔离到临时目录，不碰真实 `data/`）、`npm run test:wenyou`（千世书 vitest）、`npm run check`（tsc --noEmit）。

## 验证结果

| 检查 | 结果 |
|---|---|
| `npm test` | ✅ 204 tests / 204 pass / 0 fail（exit 0） |
| `npm run test:wenyou` | ✅ 34 files / 569 tests passed |
| `npm run check` (`tsc --noEmit`) | ✅ exit 0 |

> 说明：编写过程中暴露的 12 处失败**全部为用户侧断言/用例污染问题**（同一进程内 store 单例叠加、排序时间戳同毫秒、opencc 为字符级转换、费用公式按单笔而非累计等），均已修正；**未发现核心业务代码缺陷**。两点已观察、非 bug 的实现行为也如实记录在文末（供后续评估）。

## 新增测试文件（本会话，共 22 个）

| 测试文件 | 覆盖模块/功能 |
|---|---|
| `test/unit/chatCharacter.test.ts` | 聊一聊·自定义角色 `ChatCharacterStore`（内置小愈不可删、CRUD、字段裁剪、nameExists、用户隔离、按更新倒序、deleteByUser） |
| `test/unit/customRoleplay.test.ts` | 自建剧本 `CustomRoleplayStore`（CRUD、归属隔离、投稿/取消投稿、审核状态机 pending/approved/featured/rejected、`approve`/`reject`/`withdraw`/`setFeatured`、`listPublished`/`listFeatured`/`listApproved`/`listPending`/`listRejected`、`getPublished` 仅公开可见、update 复位、删除） |
| `test/unit/roleplaySessions.test.ts` | 角色剧情会话 `RoleplaySessionStore`（save/get、非法消息过滤、200 条上限、偏好保存、reassignUser 游客并入、删除） |
| `test/unit/roleplay.test.ts` | 剧本元数据 `roleplay.ts`（getScenario/listScenarios/listTagGroups/getDisplayLikes、中英繁本地化） |
| `test/unit/preferences.test.ts` | 用户偏好 `PreferenceStore`（默认值、部分更新不丢字段、英文模式 region 归一、setLearned ±0.12 clamp、reassignUser、listAll/remove） |
| `test/unit/session.test.ts` | 用户识别 `session.ts`（Bearer 解析、resolveUserId 登录/游客、isLoggedIn、isRecordOwner 防 IDOR） |
| `test/unit/chatCharacterGrowth.test.ts` | 角色成长档案 `ChatCharacterGrowthStore`（关系记忆去重/限长、日记/反思、自画像历史、streak/milestone/reflectionDue/portraitDue、删除） |
| `test/unit/diary.test.ts` | 心情日记 `diary.ts`（todayStr、当日首发奖励、重复提交不重复发奖、用户隔离、removeByUser） |
| `test/unit/memoryDedupe.test.ts` | 记忆去重 `memoryDedupe.ts`（normalize/isSimilar/dedupeAgainst/filterDuplicates） |
| `test/unit/embedding.test.ts` | 本地 embedding `cosine` 纯函数（同向/垂直/反向/长度不符/空） |
| `test/unit/audit.test.ts` | 操作审计 `audit.ts`（log、字段裁剪、200 条上限、倒序） |
| `test/unit/feedback.test.ts` | 用户反馈 `feedback.ts`（add 默认值/裁剪、setReward 采纳、listAll 倒序、removeByUser） |
| `test/unit/announcements.test.ts` | 公告 `announcements.ts`（单语三语同值、最多 3 条、addLangs 回退、update 保留 id/createdAt、remove） |
| `test/unit/usage.test.ts` | API 用量 `usage.ts`（record 累计 token/费用/次数、缓存命中折算、totalCost、getDailyTrend、deleteByUser） |
| `test/unit/instagram.test.ts` | Instagram 运营 `buildAuthUrl` + `InstagramStore`（连接/草稿 CRUD、markPublished、clear） |
| `test/unit/email.test.ts` | 邮箱验证码 `email.ts`（6 位码、邮箱大小写归一、一次性消费、旧码覆盖、removeByEmail） |
| `test/unit/wenyouSaves.test.ts` | 千世书进度 `wenyouSaves.ts`（set/get 不含 userId、slots 上限 50、deleteByUser） |
| `test/unit/expenses.test.ts` | 其他支出 `expenses.ts`（add 裁剪/日期回退、list 倒序、total、remove） |
| `test/unit/safeError.test.ts` | 安全错误 `safeError.ts`（按 kind 返回友好文案、未知回退 generic） |
| `test/unit/zhConvert.test.ts` | 简繁转换 `zhConvert.ts`（toZhTw/toZhSimple/toZhTwDeep 递归） |
| `test/unit/proTrial.test.ts` | 老用户 7 天 Pro `proTrial.ts`（proTrialDays、只授予注册用户、幂等） |
| `test/unit/mergeGuest.test.ts` | 游客数据并入 `mergeGuest.ts`（no-op、偏好并入账号） |

均已接入 `package.json` 的 `npm test` 脚本。

## 观察到的实现行为（非 bug，记录待评估）

- `preferenceStore.reassignUser` 只把游客偏好写入账号（当账号无记录时），**不删除游客自身记录**；对账号侧数据无影响，属无害留白。
- `roleplaySessionStore.save` 对内容为**空字符串**的合法 role 消息仍保留（只过滤非法 role / 非 string）；路由层是否 trim 由调用方决定。
- `opencc-js` 的 `cn → tw` 为**字符级**转换（如 `网络`→`網絡`、`内存`→`內存`），非台湾地区短语变体（`網路`/`記憶體`）。
