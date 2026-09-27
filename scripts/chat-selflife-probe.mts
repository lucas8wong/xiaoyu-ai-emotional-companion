/**
 * 「你自己的近况」探针（2026-09-23）：她**已经讲过的**小事，下一轮还会不会当新闻重讲一遍。
 *
 * ## 起因（真实数据）
 * 同一个糗事在三个不同会话里被讲了三次（09-20 00:26 / 01:04 / 23:04，用户原话「好像过了很久又说一次」）：
 * 「今天我自己还坐错车，一路坐到终点站才反应过来」→「今天坐错车，一路坐到终点站去了…」→
 * 「行吧，我今天坐错车一路坐到终点站…」。根因是**她说过的话没有任何地方被保存**
 * （长期记忆存的全是"关于用户的"事实、成长档案的日记反思也全是关于用户的）。
 *
 * ## 双臂（同一段状态、同一批探针，唯一差异是状态层开/关）
 *   · `on`  —— 种一条 ownLife（已讲过 1 次）后正常跑：system 里会出现
 *              「【你自己的近况 · 这些你已经讲过了】…不许再从头讲一遍」。
 *   · `off` —— 同样种了，但 `CHAT_STATE=0` 消融：整块状态不注入，她**不知道**自己讲过
 *              （这也是改制前的真实处境）。
 *
 * ## 判据（**描述性**，别当结论）
 *   · retell  —— 又把那件事**当新鲜事**讲一遍（含 坐错车/终点站 且含 今天/我刚/刚才）
 *   · refer   —— 延续/回指（含 那趟/上次/那次/还是那班/后来）
 *   · other   —— 没提这件事
 * 样本只有 4 条 × 2 臂 ⇒ 只能说方向；机制侧由确定性证据保证（system 注入 + 单测）。
 *
 * ## 用法
 *   npx tsx scripts/chat-selflife-probe.mts [--out=temp/chat-selflife-probe.json]
 *
 * ## 数据安全
 * `setupTempCwd()` 把 store 切到临时目录：**不读也不写 `data/` 的真实用户数据**；
 * ownLife 是**种到临时 store 里**的，不碰线上。
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { setupTempCwd } from '../test/unit/setup.js';

const PROJECT_ROOT = process.cwd();
dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });
setupTempCwd();

const gem: any = await import('../api/services/gemini.js');
const growth: any = await import('../api/services/chatCharacterGrowth.js');
const { createDeepSeekClient } = await import('../api/services/deepseek.js');

const argOf = (k: string): string => ((process.argv.slice(2).find((a) => a.startsWith('--' + k + '=')) || '').split('=').slice(1).join('='));
const OUT = argOf('out') || 'temp/chat-selflife-probe.json';

/** 她讲过的那件事（真实数据原文的浓缩，与 ownLife 抽取结果同形） */
const TOLD = '今天坐错车一路坐到终点站';

/**
 * 探针：都在邀请她讲"你自己"，正是当年把那件糗事勾出来的那几种处境。
 *
 * ⚠️ `direct: true` 的探针是**直接问她今天干嘛了** —— 这时她如实说今天发生了什么，
 * 是自然行为（真人被这么问也会说），**不算"把旧事当新闻重讲"**。判据必须分开算，
 * 否则会把正确行为判成 bug（第一版就是这样误判的，见脚本末尾的诚实标注）。
 */
const PROBES = [
  { key: '直问', text: '你今天干嘛了', direct: true },
  { key: '深夜', text: '还没睡，你呢', direct: false },
  { key: '逗她', text: '逗你一下', direct: false },
  { key: '在忙', text: '在忙什么', direct: false },
];

const RETELL = /坐错车|终点站/;
const AS_NEWS = /今天|我刚|刚才|刚刚/;
const REFER = /那趟|上次|那次|还是那班|后来|坐错的那/;

const client = createDeepSeekClient();
const rows: any[] = [];

async function runArm(arm: 'on' | 'off'): Promise<void> {
  if (arm === 'off') process.env.CHAT_STATE = '0'; else delete process.env.CHAT_STATE;
  const uid = 'probe-selflife-' + arm;
  growth.chatCharacterGrowthStore.setState(uid, 'xiaoyu', {
    ownLife: [{ text: TOLD, at: Date.now() - 3 * 3600_000, told: 1 }],
  });
  // 开工前先确认块到底进没进 system（确定性证据，不靠猜）
  const sys = (await gem.buildChatPromptParts([{ role: 'user', content: '在吗' }], { userId: uid }, true)).system;
  const hasBlock = String(sys).includes('【你自己的近况');
  console.log(`\n=== ${arm} 臂：状态块在 system 里 = ${hasBlock} ===`);
  for (const p of PROBES) {
    let reply = '';
    let error = '';
    try {
      const { system, user } = await gem.buildChatPromptParts([{ role: 'user', content: p.text }], { userId: uid }, true);
      const res: any = await client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'system', parts: [{ text: system }] }, { role: 'user', parts: [{ text: user }] }],
        thinkingLevel: 'off',
        feature: 'chat',
      });
      reply = String(res?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
      if (!reply) error = 'EMPTY_REPLY';
    } catch (e: any) { error = String(e?.message || e); }
    const kind = !RETELL.test(reply) ? 'other' : (AS_NEWS.test(reply) && !REFER.test(reply) ? 'retell' : 'refer');
    rows.push({ arm, key: p.key, probe: p.text, direct: !!p.direct, reply, kind, hasBlock, error });
    console.log(`\n[${arm} · ${p.key}] 「${p.text}」→ ${kind}`);
    console.log('  ' + (error || reply));
  }
}

await runArm('on');
await runArm('off');

console.log('\n=== 汇总（描述性）===');
for (const arm of ['on', 'off'] as const) {
  const rs = rows.filter((r) => r.arm === arm && !r.error);
  const indirect = rs.filter((r) => !r.direct);
  const cnt = (list: any[], k: string) => list.filter((r) => r.kind === k).length;
  console.log(`  ${arm.padEnd(4)} 成功 ${rs.length}/${PROBES.length}｜状态块在场 ${rs[0]?.hasBlock}`
    + `｜**没问她、她却主动讲旧事** retell ${cnt(indirect, 'retell')}/${indirect.length}`
    + `｜延续/回指 ${cnt(rs, 'refer')}｜没提 ${cnt(rs, 'other')}`
    + `｜（直问她今天 → ${rs.filter((r) => r.direct).map((r) => r.kind).join('/')}，这一格不算违规）`);
}
console.log('\n口径提醒：4 条 × 2 臂 ⇒ 只是方向性读数，且模型随机性会让单跑出现抖动；');
console.log('机制本身由**确定性证据**钉死：真实 system 里块在/不在（上面两行已打印）+ test/unit/chatState.test.ts。');

const outPath = path.resolve(PROJECT_ROOT, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), told: TOLD, probes: PROBES, rows }, null, 2) + '\n', 'utf8');
console.log('已写出原始数据：' + outPath);
