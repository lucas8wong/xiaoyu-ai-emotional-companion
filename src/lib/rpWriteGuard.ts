/**
 * 「未完成回合」覆盖写判定，**前后端共用同一份判据**（2026-09-18 事故后立）。
 *
 * 事故现场（线上用户 Twinkle / `6034e5e2…`《疯批总裁的白月光》，129 条）：
 * 服务端 `user-activity.json` 明明记着 09:33:23 / 09:34:11 / 09:34:34 / 09:34:54 **四轮生成成功**
 * （`api/routes/roleplay.ts` 只在回复成功后 trackFeature），可 `roleplay-sessions.json` 里
 * 这四条回复**一条都不在**，会话最后落盘在 09:37:39，却停在 09:32:58 那条用户消息上。
 * 也就是说：一个**更短**的写入把已经存下来的回复整段抹掉了，服务端一声不响。
 *
 * 短写入从哪来？客户端「重新生成」是先 `setMessages(messages.slice(0, i))`（`startRegenerate`）
 * 再请求新回复的，那个**以 user 结尾的截断态**会被自动保存立刻推上来（`RoleplayPage` 的
 * `useEffect(..., [messages, stage, selected])`）。只要新回复没回来人就走（关页面/切后台被系统挂起/
 * 网络断），落盘的就永久停在那条没人回的用户消息上，而刷新后前端既没有失败提示也没有重试入口
 *。用户看到的就是「AI 再也不回我了」。全库实测 30 / 271 个会话是这个尾部形态。
 *
 * 判据（**必须同时成立**，宁可漏拦也不误拦）：
 *   1) 新写入比已存的更短（`next.length < prev.length`）；
 *   2) 新写入的前面部分（除末条外）是已存记录的**逐条前缀**（同下标 role + content 完全一致）
 *      → 说明它是「把这条尾巴截了」，而不是带上来一段新对话（用户重复发同一句话、旧客户端补历史都不会命中）；
 *   2b) 末条**允许被改写**（同下标两边都是 user、内容不同），但要求它**不是第 0 条**。这是 2026-09
 *      「编辑重发」加的：用户改掉最后一句 → 客户端先造出「改写句 + 其后回复被截掉」的中间态。若只认 2）
 *      里那种「一字不差的前缀」，这个中间态**判据 2 不成立 → 会被真的写下去**（本地镜像 + 服务端一起），
 *      而它正是本文件开头那场事故的形态：改完一句就走人 → 落盘永久停在一条没人回的改写句上。
 *      ⚠️ `last >= 1` 这个条件是**被测试逼出来的**：起初没有它，`test/unit/roleplaySessions.test.ts` 里
 *      那条「整份历史被替换成一条超长用户消息」的既有用例立刻被误拦（那是合法写入）。取舍：改写
 *      一定发生在此前还有历史的场景（剧本开场白/上文），而"第 0 条被改写"只会出现在**整段历史被换掉**
 *      这种客户端行为里，宁可漏拦（客户端那条身份判据仍会挡住真正的中间态），也不要误拦合法写入。
 *      之所以不会误拦「用户新发一句不同的话」：那种写入**更长**，判据 1 先不成立。
 *   3) 新写入的最后一条是 **user**（没有任何 assistant 回复承接它）；
 *   4) 被截掉的那一段里**确实有 assistant 回复**（= 这一句本来有人回，别把它删了）。
 *
 * 命中即**拒写**（保留库里的回复，不写、不删）。之后客户端的下一次保存会带上新回复
 * （以 assistant 结尾）→ 判据 3 不成立 → 正常覆盖，所以「重新生成」「编辑重发」的正经用法一点不受影响。
 *
 * ⚠️ 2026-09-18 第二版：判据抽到 `src/lib/` 供**前端自动保存**复用（原来是服务端独有）。
 * 原因有两条，都在线上真实发生：
 *   ① 前端每次「重新生成」都会把那个中间截断态推给服务端 → 服务端拒写、并记一条运营埋点
 *      `roleplay / UNANSWERED_TURN`。可**用户全程什么都没看到**（这一轮新回复回来后正常落盘），
 *      于是运营端「用户实际看到失败提示」被凭空放大（当天 25 次里 16 次是这么来的）；
 *   ② 客户端的 `saveSession()` 是**先写本地镜像、再写后端**，所以服务端拒写时**本地镜像已经被截断**
 *      游客（唯一来源就是本地镜像）与后端 GET 失败的回退路径会从此比服务端少一条回复，两边分叉。
 *
 * 所以：**能确定不该写的东西，就在写之前不要写**（前端用它跳过整笔写入；服务端仍保留它作为兜底护栏，
 * 挡住旧客户端 / 另一台设备的落后状态）。
 */

/** 判据只关心 role + content，故意不绑定任何一侧的消息类型 */
export interface GuardableMessage { role: string; content: string }

export function dropsSavedReply(prev: GuardableMessage[] | undefined | null, next: GuardableMessage[] | null | undefined): boolean {
  if (!Array.isArray(prev) || !Array.isArray(next)) return false;
  if (next.length === 0 || prev.length <= next.length) return false;
  if (next[next.length - 1]?.role !== 'user') return false;
  const last = next.length - 1;
  // 前面每条必须逐条一致；只有末条允许不同（判据 2b：改写最后一句）
  for (let i = 0; i < last; i++) {
    if (prev[i]?.role !== next[i].role || prev[i]?.content !== next[i].content) return false;
  }
  const sameLast = prev[last]?.role === next[last].role && prev[last]?.content === next[last].content;
  const rewrittenLast = last >= 1 && prev[last]?.role === 'user' && next[last]?.role === 'user' && prev[last]?.content !== next[last]?.content;
  if (!sameLast && !rewrittenLast) return false;
  return prev.slice(next.length).some((m) => m?.role === 'assistant');
}
