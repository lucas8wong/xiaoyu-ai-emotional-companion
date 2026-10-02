/**
 * 剧情演绎 · AI 回复「多版本」纯逻辑（2026-09-15）
 *
 * 需求：剧情模式里 **每一条** AI 回复都要能重新生成，并且生成过的旧版本可以 ◀/▶ 回看。
 * 难点不在按钮，而在**上下文一致性**：任何一轮请求发给模型的，必须是「用户此刻正在看的那一版」，
 * 而不是被重抽掉的旧版、也不是重抽前的残留。所以这里把规则收敛成一组纯函数：
 *
 *   1. 一条消息的 `content` **永远等于** `versions[vi]`（`activeContent()` 是唯一读法）；
 *   2. 发请求前用 `toRequestMessages()` 重新取一次 `content`，上下文＝所见，杜绝脏版本回灌；
 *   3. `switchVersionIn()` 只改这一条（**不动**后面的对话），切版本纯粹是「看另一版 / 接着那一版写」；
 *   4. `startRegenerate()` / `finishRegenerate()` 负责重抽：从这条起重写（其后对话由调用方确认后清掉），
 *      新回复追加为最新一版，旧版全部保留。
 *
 * 放在 `src/lib/` 而不是组件里：可以被单测直接钉住（`test/unit/rpVersions.test.ts`），
 * 不依赖 DOM/React，这类「上下文取哪一版」的规则一旦错了，用户看到的是「AI 接着被我删掉的那版往下说」，
 * 属于必须用断言钉死的缺陷。
 *
 * ── 2026-09 追加：**用户消息的「编辑重发」**（下方独立一节，方案 1B + 2A）──
 * 用户把自己刚发的那句改一下再发。与 AI 重生成**共用同一套版本心智**（◀ n/m ▶、content === versions[vi]、
 * 上下文取当前版），但多一个「分支」概念：被改写掉的旧正文**连同它的那条回复**要冻结保留，可切回。
 * 因为限定「只有最后一条用户消息可编辑」（2A），一个分支的尾巴**最多 1 条回复**，不构成对话树。
 */

import type { RoleplayMessage } from '../services/api';

/**
 * 一条消息的全部版本（没重新生成/没编辑过 = 只有当前这一版）。
 * AI 回复走 `versions`（重新生成产生）；用户消息也走同一个字段（编辑重发产生，见文件下半节）。
 */
export function versionsOf(m: RoleplayMessage): string[] {
  const raw = Array.isArray(m?.versions) ? m.versions.filter((v): v is string => typeof v === 'string') : [];
  return raw.length > 0 ? raw : [m?.content ?? ''];
}

/** 当前选中版本下标（缺省 / 越界 / 非法值 → 最后一版） */
export function versionIndex(m: RoleplayMessage): number {
  const v = versionsOf(m);
  const i = typeof m.vi === 'number' && Number.isFinite(m.vi) ? Math.floor(m.vi) : v.length - 1;
  return i < 0 || i >= v.length ? v.length - 1 : i;
}

/** 当前显示的正文 = `versions[vi]`（渲染、复制、配音、分享、上下文都用它） */
export function activeContent(m: RoleplayMessage): string {
  const v = versionsOf(m);
  return v[versionIndex(m)];
}

/**
 * 第 i 条能不能重新生成？
 * 必须①是 AI 回复，且②**前面紧跟着一条用户消息**（剧本开场白之前没有用户消息，
 * 后端 `/chat` 也要求历史以 user 结尾：开场白是剧本设定、不是 AI 生成的，不给重生成）。
 */
export function canRegenerateAt(messages: RoleplayMessage[], i: number): boolean {
  if (!Array.isArray(messages) || i <= 0 || i >= messages.length) return false;
  return messages[i]?.role === 'assistant' && messages[i - 1]?.role === 'user';
}

/**
 * 开始重新生成第 i 条：返回「截断后的上下文 base（以 user 结尾）」+「被替换掉的那条 prev」。
 * `prev` 原样交还调用方：重生成**彻底失败**（一个字都没生成）时把它放回去，不让用户白丢一版。
 * 不能重生成（开场白 / 非法下标）→ 返回 null。
 */
export function startRegenerate(messages: RoleplayMessage[], i: number): { base: RoleplayMessage[]; prev: RoleplayMessage } | null {
  if (!canRegenerateAt(messages, i)) return null;
  return { base: messages.slice(0, i), prev: messages[i] };
}

/** 定稿一次重生成：新回复追加为最新一版并选中；旧版全部保留（可 ◀/▶ 回看） */
export function finishRegenerate(prev: RoleplayMessage, text: string): RoleplayMessage {
  const versions = [...versionsOf(prev), text];
  return { role: 'assistant', content: text, versions, vi: versions.length - 1 };
}

/**
 * 切换第 i 条的版本（dir = -1 上一版 / +1 下一版）。
 * 只改这一条：`content` 同步为选中版本；**不截断、不修改**任何其它消息（后续对话保持原样，
 * 但「下一轮 AI 接着谁写」由这条的当前版本决定）。
 * 单版消息 / 越界 → 原样返回（引用不变，避免无意义重渲染）。
 */
export function switchVersionIn(messages: RoleplayMessage[], i: number, dir: -1 | 1): RoleplayMessage[] {
  const m = messages[i];
  if (!m || m.role !== 'assistant') return messages;
  const versions = versionsOf(m);
  if (versions.length < 2) return messages;
  const cur = versionIndex(m);
  const next = Math.min(Math.max(cur + dir, 0), versions.length - 1);
  if (next === cur) return messages;
  return messages.map((x, idx) => (idx === i ? { ...x, versions, vi: next, content: versions[next] } : x));
}

/**
 * 请求上下文：每条只带 `role`/`content`，且 `content` 取**当前选中版本**。
 * 为什么必须过这一道：上下文一致性是「每条都能重生成 + 可切版本」的正确性关键
 * 只要有一处把旧版当台词发出去，模型就会接着一段用户已经看不到的剧情往下写。
 */
export function toRequestMessages(messages: RoleplayMessage[]): RoleplayMessage[] {
  return messages.map((m) => ({ role: m.role, content: activeContent(m) }));
}

/* ==================================================================== *
 * 用户消息「编辑重发」（2026-09 新增；用户拍板 1B + 2A + 3A）
 *
 * 需求原话：「用户发送一句话以后还可以修改这句话再发送」。
 *
 * 拍板口径（**不要被后人顺手放宽**）：
 *   · 1B，改写后旧的那一支**不丢**：旧正文 + 它的那条回复一起冻结保留，用户可在 ◀ n/m ▶ 切回；
 *   · 2A，**只有「最后一条用户消息」可编辑**。直接推论：一个分支的尾巴最多 1 条回复，
 *           所以这里是「两态分支」，不是对话树，不要为了「也能改历史」把它扩大成树。
 *   · 3A，聊一聊与剧情模式都要有（聊一聊那份在服务端按 timestamp 截断，见 api/routes/analysis.ts）。
 *
 * 三条不变量（错了就会出「AI 接着一段用户已经看不到的剧情往下写」这类硬伤）：
 *   1. `content === versions[vi]`（沿用 activeContent 这一条唯一读法）；
 *   2. `tails[vi]` 与主线是**互斥**的：某个版本的后续要么冻结在 tails 里、要么（只有当前版）在主线里；
 *   3. 版本/尾巴不参与模型上下文，`toRequestMessages()` 只带 role/content，尾巴是嵌套字段，天然不会漏出去。
 * ==================================================================== */

/** 用户消息最多保留的版本数（= 改写次数上限 + 1）：超出时丢最旧，**当前版永远保留** */
export const MAX_USER_VERSIONS = 3;
/**
 * 一个分支尾巴最多保留几条。
 * 2A 口径下只可能是 1 条（被改写的那句只有一条回复）；留 2 只是容忍脏数据/将来放宽，别当常规。
 */
export const MAX_BRANCH_TAIL = 2;
/** 正文长度上限（与 `api/services/roleplaySessions.ts` 的 MAX_CONTENT 同一口径） */
export const MAX_EDIT_CONTENT = 4000;

/** 最后一条用户消息的下标（没有用户消息 = -1） */
export function lastUserIndex(messages: RoleplayMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === 'user') return i;
  return -1;
}

/**
 * 第 i 条能不能「编辑重发」。
 *
 * 2A：**必须是最後一条用户消息**。为什么不让改历史：改历史等于把其后所有剧情都作废或变成树，
 * 那是 ChatGPT 那种"整条对话树"的工程量，而这里已明确不做。
 * 空正文不给编辑（没有可改的内容）；图片/语音消息也不给（剧情模式的用户消息目前只有文本，
 * 将来若带图，这里要显式排除，而不是让它默认通过）。
 */
export function canEditAt(messages: RoleplayMessage[], i: number): boolean {
  if (!Array.isArray(messages) || i < 0 || i >= messages.length) return false;
  const m = messages[i];
  if (!m || m.role !== 'user') return false;
  if (!String(m.content || '').trim()) return false;
  return lastUserIndex(messages) === i;
}

/** 这条用户消息被编辑过（有多版）才能切换分支；与「可编辑」同样是最后一条限定 */
export function canSwitchUserBranchAt(messages: RoleplayMessage[], i: number): boolean {
  return canEditAt(messages, i) && versionsOf(messages[i]).length > 1;
}

/**
 * 这条用户消息每个版本对应的**冻结尾巴**（长度与 versions 对齐；null = 该版本的后续活在主线里）。
 * 结构不合法的一律当 null，宁可少一个可切的分支，也不要拿一段脏数据当上下文。
 */
export function userTailsOf(m: RoleplayMessage): (RoleplayMessage[] | null)[] {
  const raw = Array.isArray(m?.tails) ? m.tails : [];
  return versionsOf(m).map((_, k) => {
    const t = raw[k];
    if (!Array.isArray(t) || t.length === 0) return null;
    const kept = tailMessages(t);
    return kept.length ? kept : null;
  });
}

/** 尾巴的防御性清洗（只认 role/content、限长限量），前后端共用同一份 */
function tailMessages(list: unknown[]): RoleplayMessage[] {
  return list
    .filter((x): x is RoleplayMessage => !!x && typeof x === 'object'
      && ((x as RoleplayMessage).role === 'user' || (x as RoleplayMessage).role === 'assistant')
      && typeof (x as RoleplayMessage).content === 'string')
    .slice(0, MAX_BRANCH_TAIL)
    .map((x) => ({ role: x.role, content: x.content.slice(0, MAX_EDIT_CONTENT) }));
}

/**
 * 开始一次「编辑重发」：返回**改写后的新历史**（末条 = 改写后的用户消息），不能编辑则返回 null。
 *
 * 做了三件事：
 *   ① 旧正文留成上一个版本（`versions` 末尾追加新正文，`vi` 指向新正文）；
 *   ② 旧版本那条回复**冻结进 tails**（所以界面上可以再切回去，旧剧情不丢）；
 *   ③ 主线截到这条为止，调用方拿它去跑 `runTurn`，新回复回来后就落在主线里。
 *
 * ⚠️ 调用方必须：把返回的历史只用于**请求与流式展示**，并在失败/取消/额度不足时**整份回滚**到编辑前的快照；
 *    这个「以 user 结尾的中间态」不许落盘（护栏 `dropsSavedReply` + 前端跳过，见 RoleplayPage.saveSession）。
 */
export function startEditResend(messages: RoleplayMessage[], i: number, text: string): RoleplayMessage[] | null {
  if (!canEditAt(messages, i)) return null;
  const next = String(text ?? '').trim();
  if (!next) return null;
  const m = messages[i];
  const versions = [...versionsOf(m), next.slice(0, MAX_EDIT_CONTENT)];  // 新正文追加在最后
  const tails = userTailsOf(m).slice();                                 // 对齐旧版本
  tails[versionIndex(m)] = tailMessages(messages.slice(i + 1));         // 旧版本的后续 → 冻结
  tails.push(null);                                                     // 新版本 = 主线（尾巴在主线里）
  const edited: RoleplayMessage = { role: 'user', content: next.slice(0, MAX_EDIT_CONTENT), versions, vi: versions.length - 1, tails };
  if (typeof m.timestamp === 'number') edited.timestamp = m.timestamp;
  return trimUserBranches([...messages.slice(0, i), edited]);
}

/**
 * 切换第 i 条用户消息的分支（dir = -1 上一版 / +1 下一版）。
 *
 * 与 `switchVersionIn()`（只改这一条、不动后面的对话）的关键差别：这里要**换整条尾巴**
 * 把当前主线里的后续冻结进 `tails[cur]`，再把目标版本的尾巴放回主线。两边都不丢。
 * 不重新生成、不改历史长度上限、不消耗额度（纯本地切换）。
 */
export function switchUserBranchIn(messages: RoleplayMessage[], i: number, dir: -1 | 1): RoleplayMessage[] {
  if (!canSwitchUserBranchAt(messages, i)) return messages;
  const m = messages[i];
  const versions = versionsOf(m);
  const cur = versionIndex(m);
  const to = Math.min(Math.max(cur + dir, 0), versions.length - 1);
  if (to === cur) return messages;
  const tails = userTailsOf(m).slice();
  const liveTail = tailMessages(messages.slice(i + 1));  // 当前主线的后续（2A 下 0~1 条）
  tails[cur] = liveTail.length ? liveTail : null;
  const restored = tails[to] || [];
  tails[to] = null;
  const switched: RoleplayMessage = { role: 'user', content: versions[to], versions, vi: to, tails };
  if (typeof m.timestamp === 'number') switched.timestamp = m.timestamp;
  return [...messages.slice(0, i), switched, ...restored];
}

/**
 * 固化这条用户消息的分支：只保留当前版本（丢掉其它版本与它们的尾巴）。
 *
 * 什么时候调：用户**发下一条消息**时（这条就不再是"最后一条用户消息"了）。为什么固化而不是留着：
 * ① 2A 已定的心智是「改写是当轮的事」，留着的另一支永远也切不回去（切回需要动其后所有对话 = 树）；
 * ② 每个尾巴都是一整段台词（最长 4000 字），留着就是纯死重量（`roleplay-sessions.json` 会白涨）。
 */
export function commitUserBranch(messages: RoleplayMessage[], i: number): RoleplayMessage[] {
  const m = messages[i];
  if (!m || m.role !== 'user' || versionsOf(m).length < 2) return messages;
  const kept: RoleplayMessage = { role: 'user', content: activeContent(m) };
  if (typeof m.timestamp === 'number') kept.timestamp = m.timestamp;
  return messages.map((x, idx) => (idx === i ? kept : x));
}

/** 内部：按上限裁剪版本（保留当前版 + 最近 MAX_USER_VERSIONS-1 个），尾巴同步裁剪、保持对齐 */
function trimUserBranches(messages: RoleplayMessage[]): RoleplayMessage[] {
  const i = lastUserIndex(messages);
  if (i < 0) return messages;
  const m = messages[i];
  const versions = versionsOf(m);
  if (versions.length <= MAX_USER_VERSIONS) return messages;
  const tails = userTailsOf(m);
  const activeIdx = versionIndex(m);
  const keep = new Set<number>([activeIdx]);
  for (let k = versions.length - 1; k >= 0 && keep.size < MAX_USER_VERSIONS; k--) keep.add(k);
  const ordered = Array.from(keep).sort((a, b) => a - b);
  const trimmed: RoleplayMessage = {
    role: 'user',
    content: versions[activeIdx],
    versions: ordered.map((k) => versions[k]),
    vi: ordered.indexOf(activeIdx),
  };
  const keptTails = ordered.map((k) => tails[k]);
  if (keptTails.some((t) => !!t && t.length > 0)) trimmed.tails = keptTails;
  if (typeof m.timestamp === 'number') trimmed.timestamp = m.timestamp;
  return messages.map((x, idx) => (idx === i ? trimmed : x));
}

/**
 * 归一化用户消息的分支字段（**前后端共用**：前端保存前、服务端 `projectMessage` 投影时各跑一次）。
 *
 * 与 assistant 的 `normalizeVersions()` 同一套口径：只认字符串版本、截断到上限、版本数 < 2 就不带字段
 * （老数据格式保持原样）、`content` 必须等于 `versions[vi]`（对不上就按 content 重建，数据自洽优先）。
 * 尾巴只保留结构合法的（丢掉整条尾巴也比把脏数据当上下文强）。
 * 服务端调用它，是为了挡住旧客户端/手改请求写进不合法结构（`roleplay-sessions.json` 是长期资产）。
 */
export function normalizeUserBranches(
  m: { role?: string; content?: string; versions?: unknown; vi?: unknown; tails?: unknown },
  maxContent: number = MAX_EDIT_CONTENT,
): Pick<RoleplayMessage, 'versions' | 'vi' | 'tails'> {
  if (!m || m.role !== 'user') return {};
  const raw = Array.isArray(m.versions) ? m.versions.filter((v): v is string => typeof v === 'string') : [];
  if (raw.length < 2) return {};
  const content = typeof m.content === 'string' ? m.content.slice(0, maxContent) : '';
  if (!content) return {}; // 正文为空的分支没有意义（也说明这份数据不对劲）→ 不带字段
  let versions = raw.map((v) => v.slice(0, maxContent));
  let vi = typeof m.vi === 'number' && Number.isFinite(m.vi) ? Math.floor(m.vi) : versions.length - 1;
  if (vi < 0 || vi >= versions.length) vi = versions.length - 1;
  if (versions[vi] !== content) {
    const found = versions.indexOf(content);
    if (found >= 0) vi = found;
    else { versions = [...versions, content]; vi = versions.length - 1; }
  }
  let tails: (RoleplayMessage[] | null)[] = versions.map((_, k) => {
    const t = Array.isArray(m.tails) ? (m.tails as unknown[])[k] : null;
    if (!Array.isArray(t)) return null;
    const kept = tailMessages(t).map((x) => ({ role: x.role, content: x.content.slice(0, maxContent) }));
    return kept.length ? kept : null;
  });
  if (versions.length > MAX_USER_VERSIONS) {
    const activeIdx = vi;
    const keep = new Set<number>([activeIdx]);
    for (let k = versions.length - 1; k >= 0 && keep.size < MAX_USER_VERSIONS; k--) keep.add(k);
    const ordered = Array.from(keep).sort((a, b) => a - b);
    versions = ordered.map((k) => versions[k]);
    tails = ordered.map((k) => tails[k]);
    vi = ordered.indexOf(activeIdx);
  }
  const out: Pick<RoleplayMessage, 'versions' | 'vi' | 'tails'> = { versions, vi };
  if (tails.some((t) => !!t && t.length > 0)) out.tails = tails;
  return out;
}

/**
 * 用户消息的分支字段能不能丢（固化/落盘前的判据）：只有真被编辑过（≥2 版）才值得带。
 * 让 RoleplayPage 少写一处 `versionsOf(m).length < 2`（这种口径散落多处最容易漂移）。
 */
export function hasUserBranches(m: RoleplayMessage): boolean {
  return m?.role === 'user' && versionsOf(m).length > 1;
}
