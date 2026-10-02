/**
 * 剧情「跨轮复读」现状扫描（只读）
 *
 * 为什么需要它：`scripts/rp-eval.mts` 的 `redundancy()` 只算**单条回复内部**的重复 n-gram，
 * **测不到跨轮复读**，而 2026-09-17 用户反馈的问题（AI 连续四轮以近乎逐字相同的句子收尾，
 * 「来，替朕揉揉这胸口…这气息的流转，是否比方才更顺遂些？」）恰恰只有跨轮才看得见。
 * 这个脚本直接用**线上真实会话**给出跨轮指标，用来给「跟用户走 / 不复读」这类提示词改动做前后对比。
 *
 * 用法：
 *   node scripts/rp-repetition-scan.mjs                 # 今天（服务器本地日）更新过的会话
 *   node scripts/rp-repetition-scan.mjs 2026-09-17      # 指定日期
 *   node scripts/rp-repetition-scan.mjs 2026-09-17 a76be16a-abfb-480d-abe7-759e7e6d32b2   # 只看某个用户
 *
 * 数据源：`data/xiaoyu.sqlite` 的 kv 表（`PERSISTENCE_PROVIDER=sqlite` 下的真实数据；
 * `data/*.json` 是 file 时代冻结的旧副本，读它会得到假读数）。**全程 readonly 打开，不写任何东西。**
 *
 * 指标（相邻两条 AI 回复之间取最大值）：
 *   - 4-gram Jaccard：字面重合度，越高越像在磨同一件事；
 *   - 最长公共子串：**可直接看出「整句被抄回来」**（中文 12 字以上基本就是复读）。
 * 经验判读：Jaccard < 0.1 且最长公共子串 < 12 字 ≈ 正常同场景承接；越高越该去看正文。
 */
import Database from 'better-sqlite3';
import path from 'node:path';

const day = process.argv[2] || new Date().toISOString().slice(0, 10);
const onlyUser = process.argv[3] || '';
const since = new Date(day + 'T00:00:00+08:00').getTime();

const db = new Database(path.join(process.cwd(), 'data', 'xiaoyu.sqlite'), { readonly: true });
const kv = (key) => {
  const row = db.prepare('select value from kv where key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
};

const norm = (s) => String(s || '').replace(/\s+/g, '');
function grams(s, n = 4) {
  const t = norm(s);
  const out = new Set();
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n));
  return out;
}
const jaccard = (a, b) => {
  const inter = [...a].filter((x) => b.has(x)).length;
  const uni = new Set([...a, ...b]).size;
  return uni ? inter / uni : 0;
};
/** 最长公共子串长度（两段回复互相抄哪句，一眼可见） */
function lcsLen(a, b) {
  const A = norm(a), B = norm(b);
  let best = 0;
  const prev = new Array(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i++) {
    const cur = new Array(B.length + 1).fill(0);
    for (let j = 1; j <= B.length; j++) {
      if (A[i - 1] === B[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
    }
    for (let j = 0; j <= B.length; j++) prev[j] = cur[j];
  }
  return best;
}

const sessions = (kv('roleplay-sessions.json') || [])
  .filter((r) => (r.updatedAt || 0) >= since && Array.isArray(r.messages) && r.messages.length >= 4)
  .filter((r) => !onlyUser || r.userId === onlyUser);

const rows = [];
for (const r of sessions) {
  const ai = r.messages.filter((m) => m.role === 'assistant');
  const us = r.messages.filter((m) => m.role === 'user');
  if (ai.length < 3) continue;
  let worstJac = 0, worstLcs = 0, worstPair = '';
  for (let k = 1; k < ai.length; k++) {
    const j = jaccard(grams(ai[k - 1].content), grams(ai[k].content));
    const l = lcsLen(ai[k - 1].content, ai[k].content);
    if (j > worstJac) { worstJac = j; worstPair = '#' + (k - 1) + '→#' + k; }
    if (l > worstLcs) worstLcs = l;
  }
  const models = {};
  ai.forEach((m) => { const key = m.model || '未记录'; models[key] = (models[key] || 0) + 1; });
  rows.push({
    user: r.userId.slice(0, 8), sid: r.scenarioId, turns: ai.length,
    avgAi: Math.round(ai.reduce((s, m) => s + m.content.length, 0) / ai.length),
    avgUser: Math.round(us.reduce((s, m) => s + m.content.length, 0) / Math.max(us.length, 1)),
    worstJac: Number(worstJac.toFixed(3)), worstLcs, worstPair, models: JSON.stringify(models),
  });
}
rows.sort((a, b) => b.worstJac - a.worstJac);

console.log('日期 ' + day + '｜更新过的剧情会话 ' + rows.length + ' 条（AI 回复 ≥3 条才计入）' + (onlyUser ? '｜用户 ' + onlyUser : ''));
console.log('user      scenario                            轮   AI均字  用户均字  最差Jaccard  最长公共子串  出现于       模型');
for (const r of rows) {
  console.log(
    r.user.padEnd(10) + r.sid.padEnd(36) + String(r.turns).padStart(3) + String(r.avgAi).padStart(8) +
    String(r.avgUser).padStart(9) + String(r.worstJac).padStart(12) + String(r.worstLcs).padStart(13) +
    '  ' + r.worstPair.padEnd(11) + r.models,
  );
}
db.close();
