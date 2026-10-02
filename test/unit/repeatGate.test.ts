/**
 * A 方案（生成后重复闸）回归网，2026-09-24
 *
 * 为什么必须钉死这些断言：
 * 前三轮（提示词 / 采样参数 / 换模型）用真实数据证明「模型行为不可控、上游噪声大于效应」，
 * 所以这一层是**唯一确定性**的护栏。它有两种失效方式，都要挡住：
 *   ① 判据失灵（该抓的不抓），被投诉那位用户的逐字跨度只有 45 字，纯 severe 判据抓不到他，
 *      所以必须有 circulating 这一路；
 *   ② 采纳策略失灵（把"少写"当成"不复读"），GLM-4-32B 的教训：回复短一半，重复指标立刻好看。
 *
 * ⚠️ 样本长度本身也是断言的一部分：所有"回复"样本都 ≥ RP_REPEAT_MIN_CHARS(80)，
 *    否则测的就不是判据而是"短回复被跳过"这条早退分支。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const gate: any = await import('../../api/services/repeatGate.js');
const rp: any = await import('../../api/services/roleplay.js');

/** 26 字：够 circulating 阈值（20），远不到 severe（80），正是被投诉用户那句「掌心热度」的形态 */
const CIRC = '周既白的手指在你腰窝处轻轻按揉了一圈，动作连贯而有力。';
/** ≥100 字的连续片段（severe 判据用） */
const LONG = '（他垂着眼，把外袍的下摆拢好，动作不急不缓。）“先把这碗汤喝了，凉了就没用了。”'
  + '他说话的时候没有看你，只是把碗往你面前推了推，指尖在碗沿上停了片刻，像是在等一个回答。';
/** 互不共享 ≥20 字片段的中性填充（防止测试自己制造假阳性） */
const F1 = '他把窗推开一条缝，夜风灌进来，桌上的纸角翻了翻，又慢慢落回去。';
const F2 = '院子里的水缸结了一层薄冰，映着廊下那盏灯，亮得有些冷。';
const F3 = '远处传来更鼓声，一下，两下，随后就断了，只剩檐下的风。';
const F4 = '灶上的水开了，壶盖轻轻跳着，他把火压小，又添了半勺茶叶。';
const F5 = '他解开外袍的第一颗扣子，又停住，重新系好，像是改了什么主意。';
const F6 = '她把窗纸上的破洞用米糊补上，指尖在纸面上抹了两下才收回。';
const F7 = '桌上摆着两只空碗，另一只到底给谁，他始终没有说出口。';
const F8 = '灯芯烧短了，他伸手把灯往你那边挪了挪，没有出声。';

const H = (content: string) => ({ role: 'assistant', content });
const len = (s: string) => s.replace(/\s+/g, '').length;

const SEV_PREV = F1 + LONG + F2;
const SEV_REPLY = F4 + LONG + F5;
const CIRC_PREV1 = F1 + CIRC + F2;
const CIRC_PREV2 = F3 + CIRC + F5;
const CIRC_REPLY = F7 + CIRC + F4;
const REP_HISTORY = [H(CIRC_PREV1), H(CIRC_PREV2)];

test('样本自身够长（否则下面的断言测的是"短回复早退"而不是判据）', () => {
  // ⚠️ 别写成 `len(s) >= X ?? 80`，`>=` 比 `??` 结合得更紧，会变成 `(len>=X) ?? 80` 恒为 false。
  for (const [name, s] of [['SEV_REPLY', SEV_REPLY], ['SEV_PREV', SEV_PREV], ['CIRC_REPLY', CIRC_REPLY], ['CIRC_PREV1', CIRC_PREV1], ['CIRC_PREV2', CIRC_PREV2]] as [string, string][]) {
    assert.ok(len(s) >= 80, name + ' 太短：' + len(s));
  }
  assert.ok(len(F6 + F7 + F8 + F4) >= 80, '干净样本太短：' + len(F6 + F7 + F8 + F4));
});

/* ------------------------- 判据 ------------------------- */

test('severe：与任一条前文有 ≥80 字逐字重复 → 命中 verbatim', () => {
  // 第二条前文必须与 SEV_REPLY 无共享片段，否则会连带触发 circulating（样本设计缺陷）
  const f = gate.findRepeat(SEV_REPLY, [H(SEV_PREV), H(F6 + F7)], 'zh');
  assert.equal(f.hit, true);
  assert.deepStrictEqual(f.reasons, ['verbatim']);
  assert.ok(f.longestSpan >= 80, '长公共片段没被量到：' + f.longestSpan);
  assert.equal(f.spans.length, 1);
  // 点名片段会被截到 60 字（限长），所以断言"取自那段重复"而不是全等
  assert.ok(f.spans[0].includes('先把这碗汤喝了'), '点名片段必须取自判定出的重复片段：' + JSON.stringify(f.spans));
});

test('⭐ circulating：同一 ≥20 字片段出现在 2 条前文 → 命中（被投诉用户的形态：逐字跨度仅 26 字）', () => {
  const f = gate.findRepeat(CIRC_REPLY, REP_HISTORY, 'zh');
  assert.equal(f.hit, true);
  assert.deepStrictEqual(f.reasons, ['circulating']);
  assert.ok(f.longestSpan < 80, '本例刻意不超过 severe 阈值（要证明循环这一路自己抓得住）：' + f.longestSpan);
  assert.equal(f.circulating, 2);
  assert.equal(f.spans.length, 1, '只该点名一条：' + JSON.stringify(f.spans));
  // 公共片段可能带上紧邻的句号（`F7` 与 `F1` 都以「。」结尾），断言其包含那句循环原文即可
  assert.ok(f.spans.some((s: string) => s.includes('周既白的手指在你腰窝处轻轻按揉了一圈')), '点名片段应当是那句循环的原文：' + JSON.stringify(f.spans));
});

test('干净历史 → 不命中（不能把正常写作误判成复读）', () => {
  const reply = F6 + F7 + F8 + F4;
  assert.ok(len(reply) >= 80, '干净样本太短：' + len(reply));
  const f = gate.findRepeat(reply, [H(F1 + F2), H(F3 + F5)], 'zh');
  assert.equal(f.hit, false);
  assert.deepStrictEqual(f.reasons, []);
  assert.deepStrictEqual(f.spans, []);
});

test('前文不足 2 条 → 不判（只有一条前文时"像"几乎是必然的）', () => {
  assert.equal(gate.findRepeat(SEV_REPLY, [H(SEV_PREV)], 'zh').hit, false);
  assert.equal(gate.findRepeat(SEV_REPLY, [], 'zh').hit, false);
});

test('过短回复（< RP_REPEAT_MIN_CHARS）不判，避免短回复误伤', () => {
  const f = gate.findRepeat('“手给我。”', REP_HISTORY, 'zh');
  assert.equal(f.hit, false);
  assert.equal(f.compared, 0, '早退分支不应产生比对计数');
});

test('英文阈值更宽（severe 160 / circ 40）：33 字符片段的 2 次复现 zh 命中、en 不命中', () => {
  const CHUNK = 'pressed his palm against your back';
  const reply = 'The kettle on the stove began to sing and he banked the fire down. ' + CHUNK + ', slowly and without any hurry at all, and then he said nothing more to you.';
  const history = [
    H('The wind came through the gap in the window and the paper on the desk lifted. ' + CHUNK + ', and then he let go.'),
    H('The water jar in the yard had a thin sheet of ice over it. ' + CHUNK + ', as if he had all night.'),
  ];
  assert.ok(len(reply) >= 80);
  assert.equal(gate.findRepeat(reply, history, 'zh').hit, true, 'zh：33 字 ≥ circ(20) 且出现 2 次 → 应命中');
  assert.equal(gate.findRepeat(reply, history, 'en').hit, false, 'en：33 字符未达 circ(40)，也未达 severe(160) → 不该命中');
});

/* ------------------------- 采纳策略 ------------------------- */

async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]!; }
  try { await fn(); } finally {
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('命中后重写：新一版确实更干净 → 采纳，且只重写一次', async () => {
  const fresh = F6 + F7 + F8 + F4; // 与 history 无 ≥20 字共享
  let calls = 0;
  const r = await gate.runRepeatGate({
    reply: CIRC_REPLY, history: REP_HISTORY, lang: 'zh', adult: true,
    regenerate: async (ban: string[]) => { calls += 1; assert.ok(ban.length === 1 && ban[0].includes('周既白的手指在你腰窝处轻轻按揉了一圈'), '重写必须带上点名禁项：' + JSON.stringify(ban)); return { reply: fresh, payload: 'OK' }; },
  });
  assert.equal(calls, 1, '只允许重写一次');
  assert.equal(r.gated, true);
  assert.equal(r.accepted, true);
  assert.equal(r.outcome.reply, fresh);
  assert.equal(r.outcome.payload, 'OK');
});

test('⭐ 字数缩水就**不采纳**（把"少写"当"不复读"是 GLM-4-32B 那次实验的陷阱）', async () => {
  const r = await gate.runRepeatGate({
    reply: CIRC_REPLY, history: REP_HISTORY, lang: 'zh', adult: true,
    regenerate: async () => ({ reply: '（他点了点头。）', payload: 'SHORT' }),
  });
  assert.equal(r.gated, true);
  assert.equal(r.accepted, false, '虽然更干净，但字数缩水过多，必须保留原文');
  assert.equal(r.outcome.reply, CIRC_REPLY);
});

test('重写没变干净（重复度没下降）→ 保留原文', async () => {
  const same = F6 + CIRC + F7 + F8; // 仍然带着那句循环片段
  const r = await gate.runRepeatGate({
    reply: CIRC_REPLY, history: REP_HISTORY, lang: 'zh', adult: true,
    regenerate: async () => ({ reply: same, payload: 'SAME' }),
  });
  assert.equal(r.accepted, false);
  assert.equal(r.outcome.reply, CIRC_REPLY);
});

test('重写调用抛错 / 返回空 → 保留原文，绝不把已有内容弄丢', async () => {
  const a = await gate.runRepeatGate({ reply: CIRC_REPLY, history: REP_HISTORY, lang: 'zh', adult: true, regenerate: async () => { throw new Error('boom'); } });
  assert.equal(a.outcome.reply, CIRC_REPLY);
  assert.equal(a.accepted, false);
  const b = await gate.runRepeatGate({ reply: CIRC_REPLY, history: REP_HISTORY, lang: 'zh', adult: true, regenerate: async () => ({ reply: '   ', payload: 'X' }) });
  assert.equal(b.outcome.reply, CIRC_REPLY);
});

test('开关：RP_REPEAT_GATE=0 → 完全不评估，也不重写', async () => {
  await withEnv({ RP_REPEAT_GATE: '0' }, async () => {
    let calls = 0;
    const r = await gate.runRepeatGate({ reply: CIRC_REPLY, history: REP_HISTORY, lang: 'zh', adult: true, regenerate: async () => { calls += 1; return { reply: '（他点了点头。）', payload: 'x' }; } });
    assert.equal(calls, 0);
    assert.equal(r.gated, false);
    assert.equal(r.outcome.reply, CIRC_REPLY);
  });
});

test('范围：默认 adult，没走去限制模型的回合不评估；scope=all 才评估', async () => {
  await withEnv({ RP_REPEAT_GATE_SCOPE: undefined }, async () => {
    let calls = 0;
    const r = await gate.runRepeatGate({ reply: CIRC_REPLY, history: REP_HISTORY, lang: 'zh', adult: false, regenerate: async () => { calls += 1; return { reply: 'x', payload: 'x' }; } });
    assert.equal(calls, 0);
    assert.equal(r.gated, false);
  });
  await withEnv({ RP_REPEAT_GATE_SCOPE: 'all' }, async () => {
    let calls = 0;
    const r = await gate.runRepeatGate({ reply: CIRC_REPLY, history: REP_HISTORY, lang: 'zh', adult: false, regenerate: async () => { calls += 1; return { reply: F6 + F7 + F8 + F4, payload: 'x' }; } });
    assert.equal(calls, 1, 'scope=all 时非成人回合也要判');
    assert.equal(r.gated, true);
  });
});

/* ------------------------- 注入 ------------------------- */

test('重写轮的点名禁项会进「本轮禁止复现」段，且排在通用清单之前', () => {
  const block = rp.buildAntiRepeatBlock('zh', REP_HISTORY, [CIRC]);
  assert.ok(block.includes('本次是重写'), '缺少"这是重写"的明确指令');
  assert.ok(block.includes(CIRC), '点名片段没进提示词');
  assert.ok(block.indexOf(CIRC) < block.indexOf('本轮禁止复现'), '点名片段必须排在最前（权重最高）');
  assert.ok(!rp.buildAntiRepeatBlock('zh', REP_HISTORY).includes('本次是重写'), '普通轮不该出现重写专区');
});

test('重写轮禁项最多 3 条、单条限长 60 字（避免这一段自己变成噪声源）', () => {
  const block = rp.buildAntiRepeatBlock('zh', [], ['甲'.repeat(200), '乙'.repeat(120), '丙'.repeat(120), '丁'.repeat(120)]);
  const count = (block.match(/（\d+）「/g) || []).length;
  assert.ok(count <= 3, '点名条数应 ≤3，实际 ' + count);
  assert.ok(!block.includes('甲'.repeat(61)), '单条应被截到 60 字以内');
  assert.ok(block.includes('甲'.repeat(60)), '应保留前 60 字');
});
