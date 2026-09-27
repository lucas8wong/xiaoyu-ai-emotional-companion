/**
 * UGI 榜单选型助手（Uncensored General Intelligence Leaderboard）
 *
 * 数据源：https://huggingface.co/spaces/DontPlanToEnd/UGI-Leaderboard
 *         文件 ugi-leaderboard-data.csv
 *
 * 用法：
 *   node scripts/ugi-model-pick.mjs                       # 自动下载最新 CSV
 *   node scripts/ugi-model-pick.mjs path/to/local.csv      # 用本地 CSV（离线/加速）
 *
 * 重要局限（务必记住）：
 *   UGI 是**纯英文**基准（space tags: language:English）。它对中文能力**零信息量**。
 *   所以本脚本只用来给「英文分支」选型；中文分支必须靠 Qwen 系 + 自测，不能看这个榜。
 *
 * 选型维度说明：
 *   - Writing ✍️       文笔质量
 *   - W/10-Adherence   指令/格式遵循 —— 本项目最大风险点（我们那套规则块近百条禁令）
 *   - avg_nsfw_score   如实写成人向内容的意愿/质量
 *   - Active Parameters 决定显存：4-bit 量化约需 active×0.6~0.8 GB
 */
import fs from 'node:fs';
import path from 'node:path';

const CSV_URL =
  'https://huggingface.co/spaces/DontPlanToEnd/UGI-Leaderboard/resolve/main/ugi-leaderboard-data.csv';

/** 极简 CSV 解析（支持双引号包裹与转义引号） */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^\ufeff/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function load() {
  const arg = process.argv[2];
  if (arg) return fs.readFileSync(arg, 'utf8');
  const res = await fetch(CSV_URL, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error('下载失败 HTTP ' + res.status);
  return await res.text();
}

const rows = parseCsv(await load());
const header = rows[0];
const body = rows.slice(1).filter((r) => r.length === header.length);

const idx = (name) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error('找不到列：' + name);
  return i;
};
const C = {
  model: idx('author/model_name'),
  release: idx('Release Date'),
  active: idx('Active Parameters'),
  total: idx('Total Parameters'),
  writing: idx('Writing ✍️'),
  ugi: idx('UGI 🏆'),
  wOverall: idx('W/10 👍'),
  wDirect: idx('W/10-Direct'),
  wAdh: idx('W/10-Adherence'),
  nsfw: idx('avg_nsfw_score'),
  dark: idx('avg_dark_score'),
  thinking: idx('Is Thinking Model'),
  tmpl: idx('Prompt Template'),
};

const num = (v) => {
  const n = Number(String(v).replace(/[%,]/g, ''));
  return Number.isFinite(n) ? n : NaN;
};

const models = body.map((r) => ({
  model: r[C.model],
  release: r[C.release],
  active: num(r[C.active]),
  total: num(r[C.total]),
  writing: num(r[C.writing]),
  ugi: num(r[C.ugi]),
  wOverall: num(r[C.wOverall]),
  wDirect: num(r[C.wDirect]),
  wAdh: num(r[C.wAdh]),
  nsfw: num(r[C.nsfw]),
  dark: num(r[C.dark]),
  thinking: r[C.thinking],
  tmpl: r[C.tmpl],
}));

/** release 是 M/D/YYYY */
function releaseTs(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s).trim());
  return m ? Date.UTC(+m[3], +m[1] - 1, +m[2]) : 0;
}

function show(title, list, n = 12) {
  console.log('\n=== ' + title + ' ===');
  console.log(
    '#  '.padEnd(4) +
      'model'.padEnd(46) +
      'UGI'.padStart(7) +
      'Write'.padStart(7) +
      'Adher'.padStart(7) +
      'NSFW'.padStart(6) +
      'active'.padStart(8) +
      '  释出',
  );
  list.slice(0, n).forEach((m, i) => {
    console.log(
      String(i + 1).padEnd(4) +
        m.model.slice(0, 45).padEnd(46) +
        String(m.ugi).padStart(7) +
        String(m.writing).padStart(7) +
        String(m.wAdh).padStart(7) +
        String(m.nsfw).padStart(6) +
        String(m.active).padStart(8) +
        '  ' + m.release,
    );
  });
}

const by = (key) => (a, b) => b[key] - a[key];
const recent = (m, year = 2025) => releaseTs(m.release) >= Date.UTC(year, 0, 1);
const nsfwCapable = (m) => Number.isFinite(m.nsfw) && m.nsfw > 0;

console.log('UGI 榜单快照：' + models.length + ' 个模型，' + header.length + ' 列');
console.log('⚠️ 纯英文基准 —— 对中文能力零信息量，本脚本只用于给「英文分支」选型。');

// A. 综合
show('A. 综合 UGI 前 12（不限尺寸）', [...models].sort(by('ugi')), 12);

// B. 指令遵循（本项目最大风险点）
show(
  'B. 指令遵循 W/10-Adherence 前 12（≥12B 活跃参数，避免小模型虚高）',
  models.filter((m) => m.active >= 12).sort(by('wAdh')),
  12,
);

// C. 文笔
show(
  'C. 文笔 Writing 前 12（≥12B，且 nsfw>0 即有如实写意愿）',
  models.filter((m) => m.active >= 12 && nsfwCapable(m)).sort(by('writing')),
  12,
);

// D. NSFW 意愿
show(
  'D. NSFW 意愿 avg_nsfw_score 前 12（≥12B）',
  models.filter((m) => m.active >= 12).sort(by('nsfw')),
  12,
);

// E. 本机可跑（16GB 显存，4-bit 约 active*0.7 GB ≤ 15GB → active ≤ 21B 但留余量取 ≤16B）
show(
  'E. 本机可行（active ≤ 16B，RTX 5070 Ti 16GB / 4-bit）按 Writing 前 12',
  models.filter((m) => m.active > 0 && m.active <= 16 && recent(m)).sort(by('writing')),
  12,
);

// F. 综合推荐：近期 + 文笔 + 遵循 都过关
const combo = models
  .filter((m) => recent(m) && m.active >= 12 && m.nsfw > 0 && m.writing >= 40 && m.wAdh >= 7)
  .sort(by('ugi'));
show('F. 综合门槛（2025 后 + ≥12B + Writing≥40 + Adherence≥7 + 有 NSFW 意愿）', combo, 15);

// G. 70B 级（租卡才考虑）
show(
  'G. 70B 级（需租卡；active ≥ 60B）按 Writing 前 10',
  models.filter((m) => m.active >= 60).sort(by('writing')),
  10,
);
