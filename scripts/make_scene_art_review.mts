#!/usr/bin/env node
/**
 * 生成「图 ↔ 剧情」对照页（人工验收用）→ `temp/scene-art-review.html`
 *
 * 为什么需要：C 方案出了 480 张「每剧本每幕」的图，光看文件名根本判断不了**这张图对不对得上那段剧情**。
 * 本页把三样东西摆在一起：
 *   · 这部剧本的**剧情依据**（`scripts/scene-story-specs.json` 的 `basis`：剧本里的原话）
 *   · 这一**幕**是什么（主题中文名，如"离别/亲密/危机"）
 *   · 实际出的**图**（`public/img/roleplay-scenes/{剧本}-{幕}.webp`）
 *
 * 用法：
 *   npx tsx scripts/make_scene_art_review.mts
 * 然后浏览器打开 temp/scene-art-review.html（**跑批进行中也能看**：图缺失时自动标"待出"，刷新即可）
 *
 * ⚠️ 产物刻意放 `temp/`（不是 `public/`）：prompt 属内部工作稿，不该跟着站点部署出去。
 *    图片走相对路径 `../public/img/...`，所以 `file://` 直接打开就能看。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENE_THEMES } from '../src/lib/storyScene.js';
// ⚠️ 刻意**不静态 import `api/services/roleplay.js`**：它会把整个服务端模块图（账号/配额/偏好…）拉进来，
//    而本脚本会被"每 60 秒重生成"循环反复执行 → 没必要反复触碰生产数据模块。
//    剧本标题改成**缓存一次**（`temp/scenario-titles.json`，一天内复用）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TITLES_CACHE = path.join(ROOT, 'temp', 'scenario-titles.json');
let titles: Map<string, string>;
if (fs.existsSync(TITLES_CACHE) && Date.now() - fs.statSync(TITLES_CACHE).mtimeMs < 86400000) {
  titles = new Map(Object.entries(JSON.parse(fs.readFileSync(TITLES_CACHE, 'utf8')) as Record<string, string>));
} else {
  const { listScenarios } = await import('../api/services/roleplay.js');
  titles = new Map(listScenarios('zh').map((s) => [s.id, s.title]));
  fs.mkdirSync(path.dirname(TITLES_CACHE), { recursive: true });
  fs.writeFileSync(TITLES_CACHE, JSON.stringify(Object.fromEntries(titles), null, 1));
}
const OUT = path.join(ROOT, 'temp', 'scene-art-review.html');
const IMG_DIR = path.join(ROOT, 'public', 'img', 'roleplay-scenes');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'temp', 'scene-config.json'), 'utf8')) as {
  ownThemes: Array<{ scenarioId: string; theme: string; file: string; prompt: string; safePrompt?: string; worldview: string; place: string }>;
  masters: Array<{ scenarioId: string; file: string; prompt: string; basis?: string; place: string; worldview: string; source: string }>;
  matrix: Array<{ worldview: string; theme: string; file: string; prompt: string; negative?: string }>;
};
const specs = new Map<string, { scene: string; basis: string; place: string; mood: string; indoor: boolean; valid: boolean }>();
const specFile = path.join(ROOT, 'scripts', 'scene-story-specs.json');
if (fs.existsSync(specFile)) {
  const parsed = JSON.parse(fs.readFileSync(specFile, 'utf8')) as { items?: Array<{ scenarioId: string } & { scene: string; basis: string; place: string; mood: string; indoor: boolean; valid: boolean }> };
  for (const it of parsed.items || []) specs.set(it.scenarioId, it);
}

const themeLabel = new Map(SCENE_THEMES.map((t) => [t.id, t.label]));
const exists = (f: string) => ['webp', 'png', 'jpg'].some((e) => fs.existsSync(path.join(IMG_DIR, f.replace(/\.webp$/, '.' + e))));
/**
 * 🔴 **图片 URL 必须带 mtime 版本号**。
 * 项目自己踩过这个坑（CHANGELOG：用户看到"旧的暖光客厅"其实是浏览器缓存）：出图后文件名不变，
 * 浏览器/CDN 会继续给旧图。对照页刷新看不到更新，就是这个原因，图片 URL 一模一样。
 * 这里用**文件 mtime** 做版本号：重出即失效，刷新就一定是新图。
 */
function versioned(file: string): string {
  for (const e of ['webp', 'png', 'jpg']) {
    const f = path.join(IMG_DIR, file.replace(/\.webp$/, '.' + e));
    try { if (fs.existsSync(f) && fs.statSync(f).size > 0) return `../public/img/roleplay-scenes/${file.replace(/\.webp$/, '.' + e)}?v=${Math.floor(fs.statSync(f).mtimeMs)}`; } catch { /* 试下一个 */ }
  }
  return `../public/img/roleplay-scenes/${file}`;
}
const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 按剧本分组（保持 config 里的顺序 = 剧本清单顺序）
const byScenario = new Map<string, typeof cfg.ownThemes>();
for (const r of cfg.ownThemes) {
  if (!byScenario.has(r.scenarioId)) byScenario.set(r.scenarioId, []);
  byScenario.get(r.scenarioId)!.push(r);
}
const masterBy = new Map(cfg.masters.map((m) => [m.scenarioId, m]));

const doneOwn = cfg.ownThemes.filter((r) => exists(r.file)).length;
const doneMaster = cfg.masters.filter((m) => exists(m.file)).length;
const donePool = cfg.matrix.filter((m) => exists(m.file)).length;

function card(r: typeof cfg.ownThemes[number]): string {
  const ok = exists(r.file);
  const label = themeLabel.get(r.theme) || r.theme;
  return `<figure class="c${ok ? '' : ' pending'}" data-theme="${esc(r.theme)}">
  <div class="imgwrap"><img src="${versioned(r.file)}" alt="${esc(label)}" onerror="markPending(this)">
    ${ok ? '' : '<span class="badge">待出</span>'}</div>
  <figcaption>
    <b>${esc(label)}</b> <code>${esc(r.theme)}</code>
    <details><summary>看 prompt</summary><p class="p">${esc(r.prompt)}</p>${r.safePrompt ? `<p class="p dim">兜底：${esc(r.safePrompt)}</p>` : ''}</details>
  </figcaption>
</figure>`;
}

function poolCard(r: typeof cfg.matrix[number]): string {
  const ok = exists(r.file);
  const label = themeLabel.get(r.theme) || r.theme;
  return `<figure class="c${ok ? '' : ' pending'}" data-theme="${esc(r.theme)}">
  <div class="imgwrap"><img src="${versioned(r.file)}" alt="${esc(label)}" onerror="markPending(this)">
    ${ok ? '' : '<span class="badge">待出</span>'}</div>
  <figcaption><b>${esc(label)}</b> <code>${esc(r.theme)}</code>
    <details><summary>看 prompt</summary><p class="p">${esc(r.prompt)}</p></details></figcaption>
</figure>`;
}

const sections = [...byScenario.entries()].map(([sid, rows]) => {
  const spec = specs.get(sid);
  const m = masterBy.get(sid);
  const done = rows.filter((r) => exists(r.file)).length;
  return `<section class="sc" id="s-${esc(sid)}">
  <header>
    <h2>${esc(titles.get(sid) || sid)} <code>${esc(sid)}</code></h2>
    <div class="meta">${esc(rows[0]?.worldview || '')} · ${esc(rows[0]?.place || '')} · 专属图 <b>${done}/16</b></div>
    ${spec?.basis ? `<blockquote>📖 剧情依据：${esc(spec.basis)}</blockquote>` : '<blockquote class="dim">（无剧本推导规格，走标签兜底）</blockquote>'}
    ${spec?.scene ? `<div class="scene">🎬 场景规格：${esc(spec.scene)}</div>` : ''}
  </header>
  ${m ? `<figure class="master"><div class="imgwrap"><img src="${versioned(m.file)}" alt="主场景图" onerror="markPending(this)"></div>
      <figcaption><b>主场景图</b>（整部剧的空间）<details><summary>看 prompt</summary><p class="p">${esc(m.prompt)}</p></details></figcaption></figure>` : ''}
  <div class="grid">${rows.map(card).join('')}</div>
</section>`;
}).join('\n');

const poolByWv = new Map<string, typeof cfg.matrix>();
for (const r of cfg.matrix) {
  if (!poolByWv.has(r.worldview)) poolByWv.set(r.worldview, []);
  poolByWv.get(r.worldview)!.push(r);
}
const poolSections = [...poolByWv.entries()].map(([wv, rows]) => `<section class="sc" id="p-${esc(wv)}">
  <header>
    <h2>共享主题池 · ${esc(wv)} <code>${esc(wv)}</code></h2>
    <div class="meta">${rows.filter((r) => exists(r.file)).length}/16 · 自建剧本与"尚未出专属图"时兜底用；同一世界观下全站剧本共用</div>
  </header>
  <div class="grid">${rows.map(poolCard).join('')}</div>
</section>`).join('\n');

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>剧情背景图对照验收（每剧本 × 每一幕）</title>
<style>
:root{--bg:#FBF6EE;--ink:#243B2E;--line:#e3ded4;--green:#1FA46B}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
header.top{position:sticky;top:0;z-index:9;background:#fffdf8;border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
header.top b{color:var(--green)}header.top .sp{flex:1}
header.top label{cursor:pointer;user-select:none}
.toc{display:flex;gap:6px;flex-wrap:wrap;padding:8px 16px;border-bottom:1px solid var(--line);background:#fffdf8}
.toc a{font-size:12px;padding:2px 8px;border:1px solid var(--line);border-radius:99px;text-decoration:none;color:var(--ink)}
section.sc{padding:18px 16px;border-bottom:1px solid var(--line)}
section.sc h2{margin:0 0 4px;font-size:17px}section.sc code{font-size:11px;color:#7a8a80;font-weight:400}
.meta{font-size:12px;color:#6b7a70}
blockquote{margin:8px 0;padding:8px 12px;border-left:3px solid var(--green);background:#fff;font-size:13px}
blockquote.dim,.dim{color:#98a49c}
.scene{font-size:12px;color:#6b7a70;background:#fff;padding:6px 10px;border-radius:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin-top:12px}
figure{margin:0;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden}
figure.master{max-width:330px;margin-top:12px}
/* ⚠️ 预览口径必须**跟着线上走**（这是本页唯一的诚实性要求）。
   线上 = object-cover 满屏铺底 + 手机实际裁切（用户 2026-09-15 看过 contain 方案后选择回退），
   所以默认就按「手机实际显示」预览（容器 421×631 真机实测）；勾 raw 切回原图比例（不裁切）做对比。
   ⚠️ 本注释位于模板字符串内：**不要用反引号**（会提前结束模板，2026-09-15 踩过两次）。 */
.imgwrap{position:relative;aspect-ratio:421/631;background:#eee9df;display:flex;align-items:center;justify-content:center;overflow:hidden}
.imgwrap img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
body.raw .imgwrap{aspect-ratio:auto}
body.raw .imgwrap img{position:static;object-fit:contain}
.cropnote{font-size:11px;color:#98a49c;padding:4px 10px 0}
/* 旧横版（= 还没按竖版重出）：由 JS 读 naturalWidth/naturalHeight 实时判定，跑批中刷新即更新 */
figure.stale .imgwrap::after{content:"旧横版·待重出";position:absolute;top:6px;left:6px;background:#d97706;color:#fff;font-size:11px;padding:2px 8px;border-radius:99px;z-index:2}
figure.stale{outline:2px solid #f0b46a}
body.only-stale figure:not(.stale){display:none}
.badge{position:absolute;inset:auto 8px 8px auto;background:#b9b0a3;color:#fff;font-size:11px;padding:2px 8px;border-radius:99px}
figcaption{padding:8px 10px;font-size:12px}figcaption b{font-size:13px}
details summary{cursor:pointer;color:#6b7a70;margin-top:4px}
.p{font-size:11px;line-height:1.5;color:#5d6b62;word-break:break-word;background:#faf8f3;padding:6px;border-radius:6px}
.p.dim{color:#98a49c}
body.only-pending figure:not(.pending){display:none}
</style></head><body>
<header class="top">
  <span>剧情背景图对照验收 · <b>已出 ${doneOwn}/480</b> 张专属图（主题池 ${donePool}/80 · 主场景图 ${doneMaster}/30）</span>
  <span class="sp"></span>
  <label><input type="checkbox" onchange="document.body.classList.toggle('only-pending',this.checked)"> 只看待出</label>
  <label><input type="checkbox" onchange="document.body.classList.toggle('only-stale',this.checked)"> 只看旧横版</label>
  <label><input type="checkbox" onchange="document.body.classList.toggle('raw',this.checked)"> 看原图比例（不裁切）</label>
  <span id="aspectCount" class="dim">旧横版待重出 —</span>
  <span class="dim">生成于 ${new Date().toLocaleString('zh-CN')} · 图片 URL 带 mtime 版本号 · 本页由后台定时重生成</span>
</header>
<p class="cropnote">📱 下面默认按<strong>手机实际显示</strong>预览：容器 421×631 + <code>object-cover</code>（真机实测）。看到被裁掉的样子是<strong>对的</strong>，就是用户看到的画面。出图尺寸现为 <strong>960×1280（竖版 3:4）</strong>。</p>
<div class="toc">${[...byScenario.keys()].map((sid) => `<a href="#s-${esc(sid)}">${esc(titles.get(sid) || sid)}</a>`).join('')}${[...poolByWv.keys()].map((wv) => `<a href="#p-${esc(wv)}">池·${esc(wv)}</a>`).join('')}</div>
${sections}
${poolSections}
<script>
function markPending(img){
  var f=img.closest('figure'); if(f) f.classList.add('pending');
  var w=img.parentElement; img.remove();
  if(w && !w.querySelector('.badge')){var b=document.createElement('span');b.className='badge';b.textContent='待出';w.appendChild(b);}
}
// 实时判定"这张图还是不是旧的横版"：直接读图片自身的宽高，不改任何文件。
// 旧横版口径：1024x576（SDXL）/ 1280x720（第一轮错误比例的云图）；新口径：960x1280 竖版。
function flagAspect(img){
  var f=img.closest('figure'); if(!f) return;
  var w=img.naturalWidth,h=img.naturalHeight; if(!w||!h) return;
  if(w>=h) f.classList.add('stale');
  updateCounts();   // 每张图加载完就刷新计数（480 张懒加载，window.load 不会及时触发）
}
function updateCounts(){
  var all=document.querySelectorAll('figure').length;
  var stale=document.querySelectorAll('figure.stale').length;
  var pending=document.querySelectorAll('figure.pending').length;
  var portrait=all-stale-pending;
  var el=document.getElementById('aspectCount');
  if(el) el.innerHTML='✅ 竖版 <b>'+portrait+'</b> · ⚠️ 旧横版 <b>'+stale+'</b> · ⬜ 待出 <b>'+pending+'</b>（共 '+all+'）';
}
document.querySelectorAll('figure img').forEach(function(img){
  if(img.complete && img.naturalWidth) flagAspect(img);
  else img.addEventListener('load',function(){flagAspect(img);});
  img.addEventListener('error',function(){img.remove();});
});
updateCounts();
</script>
</body></html>`;

fs.writeFileSync(OUT, html);
console.log(`OK ${path.relative(ROOT, OUT)}`);
console.log(`  已出：专属图 ${doneOwn}/480 · 主题池 ${donePool}/80 · 主场景图 ${doneMaster}/30`);
console.log(`  打开：file:///${OUT.replace(/\\/g, '/')}`);
