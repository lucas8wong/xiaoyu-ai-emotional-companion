/**
 * 复刻：用**某个用户本人的自建剧本 + 本人一模一样的输入序列**，跑**当前**的生产链路，看观感差异。
 *
 * 为什么要这样复刻：模型行为没法单测，跨轮复读/推进是否跟人走更是「同一段输入下才显现」的现象
 * 唯一的诚实做法是**同样的输入、同样的剧本、同样的偏好、同样的模型**，只换代码/配置，看输出差异。
 *
 * 保真度说明（哪些与线上一致、哪些拿不到）：
 *   ✔ 剧本对象（自建剧本的 aiPersona/background/opening）、aiName、叙事风格 immersive、内部独白开、
 *     剧本偏好原文（system 末尾的偏好块）、无限制模式=true（走 Featherless 27B abliterated）、
 *     历史条数上限 slice(-24)（路由层口径）、语言 zh。
 *   ✘ userName 拿不到（会话里不存客户端传来的名字）→ 用默认「用户」；
 *   ✘ 线上还有 longMemory / 行为感知等注入，本脚本不接（复刻只针对提示词主干）。
 *
 * 只读数据、且切到临时 cwd：**不写线上 data/、不记用量账本**。
 *
 * 用法：npx tsx scripts/rp-replay-session.mts <臂名> <run序号>
 *   臂名      after=当前代码（含 A/D/E/B）；nopenalty=消融（去掉 D 的 penalty）；afterE=历史快照名（仅用于文件名）
 *   环境变量：
 *     RP_REPLAY_USER / RP_REPLAY_SCENARIO   换复刻对象（默认是 2026-09-17 反馈里那位用户的自建剧本）
 *     RP_REPLAY_FROM=<第几条用户消息起>（1 起）**种子式复刻**：之前的轮次用**她的真实记录**当历史，
 *       只从这一轮开始重新生成，会话很长（60+ 轮）时用它，几分钟就能看到后段效果。
 *     RP_REPLAY_MAX=<只跑前 N 轮>             冒烟用
 *     RP_REPLAY_DIR=<产物目录>                默认 temp/rp-replay（换用户时建议换目录，别混在一起）
 * 产物：<dir>/<臂名>-run<n>.json（含逐轮 user/reply 全文 + 对应的真实回复 realReplies）
 *       再用 scripts/rp-replay-report.mjs 出指标表，或 temp/make-replay-compare.mjs 出可读并列文档。
 */
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import { setupTempCwd } from '../test/unit/setup.js';

const ROOT = process.cwd();
/** 复刻对象：默认取 2026-09-17 反馈里那一段（用户「蕊蕊」的自建剧本「太监」）；可用环境变量换。 */
const USER = process.env.RP_REPLAY_USER || 'a76be16a-abfb-480d-abe7-759e7e6d32b2';
const SID = process.env.RP_REPLAY_SCENARIO || 'custom_mu513kzrg3hcek';
const arm = (process.argv[2] || 'after').trim();
const runIdx = (process.argv[3] || '1').trim();

dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
if (arm === 'nopenalty') {
  // 消融臂：去掉 D（参数层），只留提示词层
  process.env.RP_ZH_EXTRA_BODY = JSON.stringify({ chat_template_kwargs: { enable_thinking: false } });
}

// 【读数必须在 chdir 之前】
const db = new Database(path.join(ROOT, 'data', 'xiaoyu.sqlite'), { readonly: true });
const kv = (k) => { const r = db.prepare('select value from kv where key = ?').get(k); return r ? JSON.parse(r.value) : null; };
const custom = (kv('custom-roleplay.json') || []).find((c) => c && c.id === SID);
const session = (kv('roleplay-sessions.json') || []).find((r) => r && r.userId === USER && r.scenarioId === SID);
db.close();
if (!custom || !session) { console.error('取不到剧本或会话'); process.exit(1); }

const allMsgs = session.messages.map((m) => ({ role: m.role, content: m.content }));
const userIdxs = allMsgs.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
const totalUserTurns = userIdxs.length;
const from = Math.max(1, Number(process.env.RP_REPLAY_FROM || 1));       // 从第几条用户消息开始**重新生成**
const maxN = Number(process.env.RP_REPLAY_MAX || 0);
/** 种子历史：from>1 时，前面的轮次直接用她的真实记录（用户 + 她当时得到的 AI 回复） */
const seed = from > 1 ? allMsgs.slice(0, userIdxs[from - 2] + 1) : [];
const todo = userIdxs.slice(from - 1).map((idx) => allMsgs[idx].content).slice(0, maxN || undefined);
/** 与 todo 一一对应的「她当年真实得到的 AI 回复」，用于并排对比 */
const realReplies = userIdxs.slice(from - 1).slice(0, maxN || undefined)
  .map((idx) => (allMsgs[idx + 1] && allMsgs[idx + 1].role === 'assistant' ? allMsgs[idx + 1].content : ''));
const pref = session.userPreference || '';

const lastSentence = (s: string) => {
  const parts = String(s || '').split(/[。！？!?]/).map((x) => x.replace(/[\s」”"'）)]+$/, '').trim()).filter(Boolean);
  return (parts[parts.length - 1] || '').slice(-50);
};
const origTails = allMsgs.filter((m) => m.role === 'assistant')
  .map((m) => ({ len: m.content.length, tail: lastSentence(m.content) }));

setupTempCwd();
const rp: any = await import('../api/services/roleplay.js');
console.log('臂=' + arm + ' run=' + runIdx + '｜剧本=' + custom.title + ' / AI=' + custom.aiName
  + '｜用户消息共 ' + totalUserTurns + ' 条，本次从第 ' + from + ' 条起重新生成 ' + todo.length + ' 轮'
  + '（种子历史 ' + seed.length + ' 条）｜偏好=' + JSON.stringify(pref).slice(0, 200));
console.log('EXTRA_BODY=' + String(process.env.RP_ZH_EXTRA_BODY || ''));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const history: Array<{ role: 'user' | 'assistant'; content: string }> = [...seed];
const turns: Array<{ i: number; user: string; reply: string; ms: number; real?: string }> = [];

for (let i = 0; i < todo.length; i++) {
  history.push({ role: 'user', content: todo[i] });
  const t0 = Date.now();
  let reply = '';
  for (let attempt = 0; attempt < 3 && !reply; attempt++) {
    try {
      if (attempt) await sleep(2500 * attempt);
      reply = await rp.roleplayReplyCustom(custom, history.slice(-24), {
        lang: 'zh', aiName: custom.aiName, userPreference: pref,
        narrativeStyle: 'immersive', innerMonologueEnabled: true, unlimited: true,
      });
    } catch (e: any) {
      console.warn('⚠️ 第 ' + (from + i) + ' 轮失败（' + attempt + '）: ' + (e?.message || e));
    }
  }
  if (!reply) { console.error('❌ 第 ' + (from + i) + ' 轮彻底失败，中止'); break; }
  history.push({ role: 'assistant', content: reply });
  turns.push({ i: from + i, user: todo[i], reply, ms: Date.now() - t0, real: realReplies[i] || '' });
  console.log('#' + (from + i) + ' 她写：「' + String(todo[i]).replace(/\s+/g, ' ').slice(0, 40) + '」→ AI ' + reply.replace(/\s+/g, '').length + ' 字｜落点：「' + lastSentence(reply) + '」');
}

// ⚠️ setupTempCwd() 会 chdir 到系统临时目录 → 产物必须用**绝对路径**写回项目，
// 否则会静默写进 /tmp/cure-test-*/ 里（本次踩过：第一次跑完在项目里找不到文件）。
const OUT_DIR = path.resolve(ROOT, process.env.RP_REPLAY_DIR || path.join('temp', 'rp-replay'));
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, arm + '-run' + runIdx + '.json'),
  JSON.stringify({ arm, runIdx, userId: USER, scenario: custom.id, from, pref, turns, origTails }, null, 1));
console.log('已写入 ' + path.join(OUT_DIR, arm + '-run' + runIdx + '.json'));
process.exit(0);
