/**
 * 复刻对比分析：原会话（改前·真实记录） vs 各次复刻（改后）。
 * 读 temp/rp-replay/*.json（由 scripts/rp-replay-session.mts 产出），输出指标表 + 重复尾句 + 尾句逐轮并排。
 * 用法：node scripts/rp-replay-report.mjs
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const USER = process.env.RP_REPLAY_USER || 'a76be16a-abfb-480d-abe7-759e7e6d32b2';
const SID = process.env.RP_REPLAY_SCENARIO || 'custom_mu513kzrg3hcek';

const db = new Database(path.join(process.cwd(), 'data', 'xiaoyu.sqlite'), { readonly: true });
const kv = (k) => { const r = db.prepare('select value from kv where key = ?').get(k); return r ? JSON.parse(r.value) : null; };
const session = (kv('roleplay-sessions.json') || []).find((r) => r.userId === USER && r.scenarioId === SID);
db.close();
const origAi = session.messages.filter((m) => m.role === 'assistant').map((m) => m.content);

const norm = (s) => String(s || '').replace(/\s+/g, '');
const grams = (s, n = 4) => { const t = norm(s); const o = new Set(); for (let i = 0; i + n <= t.length; i++) o.add(t.slice(i, i + n)); return o; };
const jac = (a, b) => { const i = [...a].filter((x) => b.has(x)).length; const u = new Set([...a, ...b]).size; return u ? i / u : 0; };
function lcs(a, b) {
  const A = norm(a), B = norm(b); let best = 0, str = '';
  const prev = new Array(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i++) {
    const cur = new Array(B.length + 1).fill(0);
    for (let j = 1; j <= B.length; j++) { if (A[i - 1] === B[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) { best = cur[j]; str = A.slice(i - best, i); } } }
    for (let j = 0; j <= B.length; j++) prev[j] = cur[j];
  }
  return { len: best, str };
}
const lastSentence = (s) => {
  const parts = String(s || '').split(/[。！？!?]/).map((x) => x.replace(/[\s」”"'）)]+$/, '').trim()).filter(Boolean);
  return (parts[parts.length - 1] || '').slice(-50);
};
const WORDS = ['替朕', '气息的流转', '顺遂', '莫要拘谨', '气息'];

function score(name, aiTexts) {
  const joined = aiTexts.join('\n');
  let worstJac = 0, worstLcs = 0, worstPair = '', worstStr = '';
  for (let k = 1; k < aiTexts.length; k++) {
    const j = jac(grams(aiTexts[k - 1]), grams(aiTexts[k]));
    const l = lcs(aiTexts[k - 1], aiTexts[k]);
    if (j > worstJac) { worstJac = j; worstPair = '#' + k + '→#' + (k + 1); }
    if (l.len > worstLcs) { worstLcs = l.len; worstStr = l.str; }
  }
  const tails = aiTexts.map(lastSentence);
  const dup = {};
  tails.forEach((t) => { dup[t] = (dup[t] || 0) + 1; });
  const repeats = Object.entries(dup).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
  const kw = {}; WORDS.forEach((w) => { kw[w] = (joined.match(new RegExp(w, 'g')) || []).length; });
  return {
    name, n: aiTexts.length,
    avgLen: Math.round(aiTexts.reduce((s, t) => s + t.length, 0) / Math.max(aiTexts.length, 1)),
    worstJac: Number(worstJac.toFixed(3)), worstPair, worstLcs, worstStr, kw, repeats, tails,
  };
}

const sources = [score('原会话（改前·她真实记录）', origAi)];
for (const f of fs.readdirSync('temp/rp-replay').filter((x) => /^(aD|after|afterB|nopenalty)-run\d+\.json$/.test(x)).sort()) {
  const j = JSON.parse(fs.readFileSync('temp/rp-replay/' + f, 'utf-8'));
  // 前缀决定标签：aD=方案A+D（E 前）／after=当前代码（E 后）／nopenalty=只留 A 的消融臂
  const tag = f.startsWith('aD') ? '复刻 A+D（E 前）'
    : f.startsWith('nopenalty') ? '复刻 仅A（消融）'
      : f.startsWith('afterB') ? '复刻 A+D+E+B'
        : '复刻 A+D+E（E 后）';
  sources.push(score(tag + ' ' + f.replace(/\.json$/, '').replace(/^(aD|afterB|after|nopenalty)-/, ''), j.turns.map((t) => t.reply)));
}

console.log('==== 指标对比（AI 回复） ====');
console.log('来源'.padEnd(30) + '条数  AI均字  最差Jaccard  最长公共子串  出现于     替朕  气息流转  顺遂  莫要拘谨');
for (const s of sources) {
  console.log(s.name.padEnd(30) + String(s.n).padStart(4) + String(s.avgLen).padStart(8) + String(s.worstJac).padStart(12) +
    String(s.worstLcs).padStart(13) + '  ' + s.worstPair.padEnd(10) +
    String(s.kw['替朕']).padStart(5) + String(s.kw['气息的流转']).padStart(9) + String(s.kw['顺遂']).padStart(6) + String(s.kw['莫要拘谨']).padStart(9));
  if (s.worstStr) console.log('    ↳ ' + s.name + ' 最长公共子串：「' + s.worstStr + '」');
}
console.log('\n==== 重复出现的尾句（≥2 次即算复读） ====');
for (const s of sources) {
  console.log('— ' + s.name + '：' + (s.repeats.length ? '' : '无'));
  for (const [t, n] of s.repeats) console.log('    ' + n + '× 「' + t + '」');
}
console.log('\n==== 尾句逐轮（便于并排看） ====');
const width = Math.max(...sources.map((s) => s.n));
for (let i = 0; i < width; i++) {
  console.log('\n# ' + (i + 1));
  for (const s of sources) console.log('  ' + s.name.padEnd(30) + (s.tails[i] ? '「' + s.tails[i] + '」' : '（无）'));
}
