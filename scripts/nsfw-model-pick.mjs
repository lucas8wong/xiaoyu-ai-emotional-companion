/**
 * NSFW 角色扮演模型选型：UGI 评分 ✕ Featherless 可用性 两张表 join
 *
 * 为什么必须 join：
 *   - UGI 榜单（英文基准）有「肯写程度 avg_nsfw_score」「文笔 Writing」「指令遵循 W/10-Adherence」
 *     但**不告诉你这个模型在哪家托管能调到、要多少显存/并发**。
 *   - Featherless 目录有 context_length / concurrency_cost，但**没有质量评分**。
 *   只有交叉之后才能回答「哪个 NSFW 模型我能真的用上」。
 *
 * 用法：node scripts/nsfw-model-pick.mjs
 *   （需先有 temp/ugi.csv 与 temp/fl.json；缺失会自动下载）
 *
 * 本项目硬门槛：
 *   context_length ≥ 32768（自建剧本最坏情况 ≈3.7K token + 多轮 history）
 *   concurrency_cost ≤ 2（$25 档仅 4 个并发单元；cost=4 的 70B 一个请求就吃光）
 *   中文能力 → 看底座（UGI 是纯英文基准，对中文零信息量）
 */
import fs from 'node:fs';

const UGI_CSV = 'temp/ugi.csv';
const FL_JSON = 'temp/fl.json';

async function ensure(url, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return;
  console.log('下载 ' + url);
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}
await ensure('https://huggingface.co/spaces/DontPlanToEnd/UGI-Leaderboard/resolve/main/ugi-leaderboard-data.csv', UGI_CSV);
await ensure('https://api.featherless.ai/v1/models', FL_JSON);

function parseCsv(text) {
  const rows = []; let row = []; let f = ''; let q = false;
  const s = text.replace(/^\ufeff/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}

// —— UGI ——
const ugiRows = parseCsv(fs.readFileSync(UGI_CSV, 'utf8'));
const H = ugiRows[0];
const col = (n) => { const i = H.indexOf(n); if (i < 0) throw new Error('UGI 缺列 ' + n); return i; };
const C = { m: col('author/model_name'), w: col('Writing ✍️'), u: col('UGI 🏆'), a: col('W/10-Adherence'), n: col('avg_nsfw_score'), d: col('avg_dark_score'), act: col('Active Parameters'), rel: col('Release Date') };
const num = (v) => { const x = Number(String(v).replace(/[%,]/g, '')); return Number.isFinite(x) ? x : NaN; };

const ugi = new Map();
for (const r of ugiRows.slice(1)) {
  if (r.length !== H.length) continue;
  ugi.set(r[C.m].toLowerCase(), {
    id: r[C.m], writing: num(r[C.w]), ugi: num(r[C.u]), adh: num(r[C.a]),
    nsfw: num(r[C.n]), dark: num(r[C.d]), active: num(r[C.act]), release: r[C.rel],
  });
}

// —— Featherless ——
const fl = (JSON.parse(fs.readFileSync(FL_JSON, 'utf8')).data || []);
const flById = new Map(fl.map((m) => [m.id.toLowerCase(), m]));

const ZHBASE = ['qwen', 'glm', 'yi-', 'deepseek', 'internlm', 'hunyuan', 'minimax', 'ernie'];
const isZh = (id) => ZHBASE.some((k) => id.toLowerCase().includes(k));
const MIN_CTX = 32768;
const MAX_CONC = 2;

/** 两边都能对上的候选 */
const joined = [...ugi.values()]
  .map((u) => ({ ...u, fl: flById.get(u.id.toLowerCase()) }))
  .filter((x) => x.fl);

function show(title, list, n = 15) {
  console.log('\n=== ' + title + ' ===');
  if (!list.length) { console.log('  （无）'); return; }
  console.log('n  '.padEnd(4) + 'model'.padEnd(50) + 'NSFW'.padStart(6) + 'Write'.padStart(7) + 'Adh'.padStart(5) + 'UGI'.padStart(7) + 'ctx'.padStart(8) + 'conc'.padStart(5) + '  中文底座');
  list.slice(0, n).forEach((x, i) => {
    console.log(
      String(i + 1).padEnd(4) + x.id.slice(0, 49).padEnd(50) +
      String(x.nsfw).padStart(6) + String(x.writing).padStart(7) + String(x.adh).padStart(5) +
      String(x.ugi).padStart(7) + String(x.fl.context_length).padStart(8) +
      String(x.fl.concurrency_cost).padStart(5) + '  ' + (isZh(x.id) ? '✅' : '—'),
    );
  });
}

console.log('UGI 收录 ' + ugi.size + ' 个；Featherless 目录 ' + fl.length + " 个；两边能对上的 " + joined.length + ' 个');

const usable = joined.filter((x) => x.fl.context_length >= MIN_CTX && x.fl.concurrency_cost <= MAX_CONC);
console.log('满足「ctx≥' + MIN_CTX + ' 且 conc≤' + MAX_CONC + '」的：' + usable.length + ' 个');

show('A. 可用候选 × 按「肯写程度 NSFW」降序（本项目首选排序）', usable.filter((x) => x.nsfw >= 6).sort((a, b) => b.nsfw - a.nsfw || b.writing - a.writing));
show('B. 可用候选 × 按「文笔」降序（仅看 NSFW≥6）', usable.filter((x) => x.nsfw >= 6).sort((a, b) => b.writing - a.writing));
show('C. 可用候选 × 按「指令遵循 Adherence」降序（NSFW≥6）', usable.filter((x) => x.nsfw >= 6).sort((a, b) => b.adh - a.adh));
show('D. 中文底座 + 可用 + NSFW≥5（中英文双适配的关键交集）', usable.filter((x) => isZh(x.id) && x.nsfw >= 5).sort((a, b) => b.nsfw - a.nsfw));

// —— Featherless 上有、但 UGI 未收录的 NSFW 命名模型 ——
const NAMED = ['nsfw', 'unslop', 'cydonia', 'magnum', 'rocinante', 'euryale', 'hanami', 'behemoth', 'sapphira', 'shakudo', 'stylizer', 'unbound', 'lumimaid', 'midnight', 'amethyst', 'fimbul', 'mytho', 'psyfighter', 'heresy', 'tainted'];
const flOnly = fl
  .filter((m) => m.context_length >= MIN_CTX && m.concurrency_cost <= MAX_CONC)
  .filter((m) => NAMED.some((k) => m.id.toLowerCase().includes(k)))
  .filter((m) => !ugi.has(m.id.toLowerCase()))
  .map((m) => ({ id: m.id, fl: m }));
console.log('\n=== E. Featherless 有、UGI 未收录（NSFW 命名惯例）的可用模型，共 ' + flOnly.length + ' 个，前 25 ===');
console.log('  注：UGI 未收录不代表差，只是没被测过——**必须自己实测**。');
flOnly.slice(0, 25).forEach((x) =>
  console.log('  ' + x.id.slice(0, 58).padEnd(59) + 'ctx=' + String(x.fl.context_length).padStart(6) + ' conc=' + x.fl.concurrency_cost + (isZh(x.id) ? '  ✅中文底座' : '')),
);
