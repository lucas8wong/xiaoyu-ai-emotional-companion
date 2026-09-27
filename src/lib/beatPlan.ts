/**
 * 「一拍计划」（beat plan）—— 写之前先想清楚这一拍**新**发生什么（2026-09-24，B 方案）
 *
 * ## 为什么要有它（与 repeatGate 的分工）
 * repeatGate 是**事后**补救：判到复读就重写一版。但它拦不住根因——那台 abliterated 模型在用户
 * 只给三个字（「嗯……」「你别这样……」）时**没有"下一步要发生什么"的内部状态**，于是只能把上一拍
 * 换个字重播一遍。实测（temp/_gate-live.mts）3 轮命中 3 轮、只有 1 轮重写被采纳，剩下两轮重写后
 * 重复度**一点没降**——因为它还是没得可写。
 * 「写前计划」把这一步显式化：**先让模型产出一行"这一拍新发生什么"，再落笔写正文**。这是文献与
 * 社区对"角色扮演循环"的常规解法（plan-then-write / beat sheet），治的是因，不是果。
 *
 * ## 为什么是「同一轮内的一行」而不是「多调一次模型」
 * 多调一次 = 每个回合都多一次上游调用 + 一整段等待（成人档单轮已 10–25s）。而把计划写成**同一轮
 * 输出的第一行**，成本只有几十个输出 token，且模型"看到自己刚写下的计划"再写正文，约束力比把计划
 * 放在 prompt 里更强。代价是**必须把这行剥干净**，否则它会泄漏给玩家、还会被当成角色台词落盘
 * （2026-09-15 事故的同类风险：系统/工具文本进了业务消息集合）。
 *
 * ## 安全设计（三条，都是"宁可退化、不可出错"）
 *   1. **只在确实还有正文时才剥**（剩余正文 < MIN_BODY_CHARS 就保留原文）——绝不因为剥离把回复吞掉；
 *   2. **流式逐字过滤**：标记行在第一行，所以只需缓冲开头几十个字符就能判定；判定失败/一行太长
 *      一律**放行原样输出**（宁可泄漏一行，也不吞正文）；
 *   3. 模型不遵守（没输出这一行）时行为**与改造前完全一致**——剥离是幂等的、无标记即不动作。
 *
 * 开关：`RP_BEAT_PLAN=0` 整块关掉（消融/止血）；生效范围默认只在成人档（见 roleplay.ts 的调用点）。
 */

/** 计划行标记（中英各一；大小写不敏感） */
export const BEAT_MARKERS: readonly string[] = ['【本拍】', '[BEAT]'];
/** 剥离后至少要剩这么多正文，否则判定为"只有计划、没有正文" → 保留原文 */
export const MIN_BODY_CHARS = 20;

export interface BeatSplit {
  /** 计划行内容（去掉标记与紧随的冒号/破折号） */
  plan: string;
  /** 去掉计划行之后的正文（未剥离时即原文） */
  body: string;
  /** 是否真的剥离了 */
  stripped: boolean;
}

const LEAD_WS = /^[\s\u3000]*/;

/** 找出第一个计划行标记；返回 [marker, 标记行的起始下标, 该行内容] */
function matchMarkerLine(text: string): { marker: string; lineStart: number; line: string; lineEnd: number } | null {
  const lead = text.match(LEAD_WS)?.[0].length ?? 0;
  const nl = text.indexOf('\n', lead);
  const lineEnd = nl === -1 ? text.length : nl;
  const line = text.slice(lead, lineEnd);
  const upper = line.trimStart().toUpperCase();
  const marker = BEAT_MARKERS.find((m) => upper.startsWith(m.toUpperCase()));
  if (!marker) return null;
  return { marker, lineStart: lead, line, lineEnd };
}

/**
 * 把「一拍计划」行从一段完整回复里剥出来。**纯函数**（可单测、可回归）。
 * 无标记 → 原样返回且 stripped=false（模型没遵守时的行为与改造前一致）。
 */
export function splitBeatPlan(input: string): BeatSplit {
  const text = String(input ?? '');
  const hit = matchMarkerLine(text);
  if (!hit) return { plan: '', body: text, stripped: false };
  const plan = hit.line.trimStart().slice(hit.marker.length).replace(/^[：:\-—·.、\s]+/, '').trim();
  const body = text.slice(hit.lineEnd + 1).replace(LEAD_WS, '');
  // 安全阀 1：确实还有正文才剥
  if (body.replace(/\s+/g, '').length < MIN_BODY_CHARS) return { plan: '', body: text, stripped: false };
  return { plan, body, stripped: true };
}

export interface BeatPlanFilter {
  /** 喂入一个流式增量（内部按需缓冲；未判定/剥离期间不发出任何内容） */
  push: (delta: string) => void;
  /** 生成结束：把还没发出的内容补发出去（绝不吞正文） */
  flush: () => void;
  /** 是否见到过计划行（供日志/埋点） */
  sawPlan: () => boolean;
}

/** 判定窗口：够放下标记 + 一点内容；超过这个长度还没匹配上就按"没有计划行"放行 */
const MAX_DECIDE = 64;
/** 计划行最长容忍；超过就认为这不是计划行（模型跑偏），放行原样输出 */
const MAX_PLAN_LINE = 600;

/**
 * 流式过滤器：与 `splitBeatPlan` 同一套判据，但**增量**处理。
 *
 * 状态机：undecided → （匹配到标记）skip →（吃到换行）pass ／（没匹配到）pass。
 * 任何"拿不准"的分支都走 pass（放行原样），因为它只可能多泄漏一行计划，
 * 而错误地 skip 会把玩家真正该看到的正文吞掉 —— 两种错的代价不对称。
 */
export function createBeatPlanFilter(emit: (delta: string) => void): BeatPlanFilter {
  let raw = '';
  let pos = 0;
  /**
   * `leadws` 是必须的中间态：计划行与正文之间的空行**可能还没到**（逐 token 场景下第二次 push
   * 才带来那个 '\n'）。若在吃到第一个 '\n' 时就直接转 pass，那个迟到的空行会被原样发出去 ——
   * 这正是单测「逐字符推入」抓到的泄漏。
   */
  let state: 'undecided' | 'skip' | 'leadws' | 'pass' = 'undecided';
  let saw = false;

  const emitRest = (): void => { if (pos < raw.length) { emit(raw.slice(pos)); pos = raw.length; } };

  function drain(final: boolean): void {
    if (state === 'pass') { emitRest(); return; }
    if (state === 'undecided') {
      const candidate = raw.slice(pos);
      const lead = candidate.match(LEAD_WS)?.[0].length ?? 0;
      const core = candidate.slice(lead);
      if (core.length === 0) {
        if (final) { state = 'pass'; emitRest(); }
        return;
      }
      const upper = core.toUpperCase();
      if (BEAT_MARKERS.some((m) => upper.startsWith(m.toUpperCase()))) {
        state = 'skip'; saw = true;
      } else if (!final && BEAT_MARKERS.some((m) => m.toUpperCase().startsWith(upper)) && candidate.length < MAX_DECIDE) {
        return; // 可能是标记的前缀（如只收到「【本」）→ 再等等
      } else {
        state = 'pass'; emitRest(); return;
      }
    }
    if (state === 'skip') {
      const nl = raw.indexOf('\n', pos);
      if (nl !== -1) { pos = nl + 1; state = 'leadws'; }
      // 还没换行：计划行不完整就继续等；等过头了/已经结束时一律放行（宁可泄漏）
      else if (final || raw.length - pos > MAX_PLAN_LINE) { state = 'pass'; emitRest(); return; }
      else return;
    }
    if (state === 'leadws') {
      while (pos < raw.length && /[\s\u3000]/.test(raw[pos])) pos += 1;
      if (pos >= raw.length) {
        // 正文还没到：继续等；已经结束则收手（此时正文为空，服务端的 splitBeatPlan 会放弃剥离，
        // 最终由 done.reply 把完整原文送回来 —— 流上少了计划行，但绝不会丢正文）
        if (final) state = 'pass';
        return;
      }
      state = 'pass';
      emitRest();
    }
  }

  return {
    push: (delta: string) => { if (!delta) return; raw += delta; drain(false); },
    flush: () => drain(true),
    sawPlan: () => saw,
  };
}
