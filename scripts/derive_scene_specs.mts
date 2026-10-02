/**
 * 剧情「场景规格」推导（2026-09-14 用户反馈后的架构修正）
 *
 * ❗ 为什么这么做：此前背景图靠**标签猜**（tags → 地点/世界观），结果把《冷峻刑警的年下法医》
 *   剧本里明明写着「**凶案现场**」「**警戒线外，雨刚停，潮湿的泥土味**」，画成了"暖阳办公/书房"。
 *   正确做法（用户指正）：**依据剧本自己的背景故事 + 故事发生的场景**来生成画面。
 *
 * 本脚本离线跑一次：对每部**内置**剧本，把它的叙事文本交给文本模型，产出**场景规格**（严格 JSON），
 * 落盘成 `scripts/scene-story-specs.json`（可审阅、可版本化、可重跑）。
 *
 * 🔴 红线（在提示词与代码两层强制）：
 *   1. 只画**环境与道具**，不出现人物（含剪影/远景行人）；不出现文字/招牌/标志/水印；
 *   2. 不出现血腥/尸体/武器特写（本产品定位"温和陪伴"，背景只需氛围，不要猎奇）；
 *   3. **只处理内置剧本**（我们的内容）。用户自建剧本的文案是用户内容，**不进任何模型**
 *      自建剧本继续走 `src/lib/storyScene.ts` 的白名单表兜底。
 *
 * 用法：
 *   npx tsx scripts/derive_scene_specs.mts --probe             # 只看抽到的叙事文本，不调模型
 *   npx tsx scripts/derive_scene_specs.mts                     # 全量推导 30 部
 *   npx tsx scripts/derive_scene_specs.mts --only lutingyuan-shenyan
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listScenarios } from '../api/services/roleplay.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(ROOT, 'scripts', 'scene-story-specs.json');

function loadEnv(): Record<string, string> {
  const p = path.join(ROOT, '.env');
  const out: Record<string, string> = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

// 【红线关键词（命中即判不合格，重试一次；仍不合格则退回白名单兜底）】
const DENY_PERSON = /\b(person|people|man|woman|boy|girl|child|kid|figure|figures|silhouette|silhouettes|crowd|face|faces|hand|hands|hair|eyes|body|bodies|he|she|they|his|her|couple|lover|detective|officer|nurse|doctor|lawyer|assistant|warrior|captain|king|queen|prince|princess)\b/i;
const DENY_TEXT = /\b(text|letter|letters|lettering|word|words|logo|signage|watermark|billboard|poster)\b/i;
const DENY_GORE = /\b(blood|bloody|corpse|dead|death|gore|gun|guns|knife|knives|weapon|weapons|drug|drugs|wound|wounds)\b/i;

export interface StorySceneSpec {
  scenarioId: string;
  /** 中文依据：剧本里的哪句话决定了这个场景（便于人工审阅） */
  basis: string;
  /** 场景短语（中文，给后台/审阅看） */
  place: string;
  /** 英文画面描述（进图像 prompt 的**唯一**内容来源） */
  scene: string;
  mood: 'cool' | 'warm' | 'neutral';
  indoor: boolean;
  /** 是否通过红线校验（false = 未采用，退回白名单兜底） */
  valid: boolean;
  /** 校验失败原因（便于排查） */
  reject?: string;
  model?: string;
  derivedAt?: string;
}

function narrativeOf(s: ReturnType<typeof listScenarios>[number]): { title: string; tags: string[]; text: string } {
  // ⚠️ listScenarios(lang) 返回的是**已按语言摊平**的对象：字段在顶层（title/background/openingScene/…），
  //    不在 `zh` 子对象里（这点踩过：先前按 s.zh 取，抽出来是空的）。
  const o = s as unknown as Record<string, unknown>;
  const zh = (o.zh as Record<string, unknown> | undefined) || o;
  const ai = (zh.ai || {}) as Record<string, string>;
  const title = String(zh.title || s.id);
  const tags = Array.isArray(zh.tags) ? (zh.tags as string[]) : [];
  const lines = [
    `标题：${title}`,
    `一句话定位：${String(zh.tagline || '')}`,
    `简介：${String(zh.shortDesc || '')}`,
    `标签：${tags.join('/')}`,
    `背景故事：${String(zh.background || '')}`,
    `开场场景：${String(zh.openingScene || '')}`,
    `开场白正文：${String(zh.openingAssistant || '')}`,
    ai.looks ? `角色气质（仅用于判断场景风格，不要画人）：${ai.looks}` : '',
  ];
  const text = lines.filter(x => x && !x.endsWith('：')).join('\n');
  return { title, tags, text };
}

const SYSTEM = [
  '你是影视美术指导。根据给定的剧本信息，判断"故事发生在什么样的场景里"，并输出一个**只描述环境**的画面描述。',
  '硬性要求：',
  '1. 只描述**空间、光线、材质、天气、道具**；**绝对不能出现人物**（也不要人物剪影、远景行人、镜中人），不要出现人的身体部位。',
  '2. 不要出现任何文字、招牌、标语、标志、水印、屏幕上的字。',
  '3. 不要血腥、尸体、武器、毒品等猎奇元素，这是温和的陪伴类产品，背景只要**氛围**。',
  '4. 场景必须**依据剧本给的背景故事/开场场景/开场白正文**来定；剧本里写了"雨、积水、警戒线、泥土味"就画这些，不要替换成通用办公室或家居。',
  '5. ⚠️ **必然有人的场面**（游行/婚礼/宴会/案发现场/舞会/人群）→ 请改画**同一场景在"人刚散去/尚未到场"时的样子**：',
  '   同一地点、同一批道具（花轿、红绸、灯笼、警戒线、餐盘…）、同样的光线与天气，但画面里空无一人。例如"婚轿游街"→ 画"游街过后的长街：路边停着的花轿、散落的红绸、湿石板路"。',
  '5. indoor 表示场景主要在室内还是室外（凶案现场/街道/天台 = false）。',
  '6. mood：冷(cool)/暖(warm)/中性(neutral)，按剧情气质定（冷峻、悬疑、雨夜 → cool；温柔、日常、烛光 → warm）。',
  '只输出 JSON：{"basis":"剧本中决定场景的那句话（中文，20字内）","place":"场景短语（中文，10字内）","scene":"English visual description, 14-24 words, comma-separated visual elements ONLY (no full sentences, no colon, no lists of clauses)","mood":"cool|warm|neutral","indoor":true|false}',
  '⚠️ scene 必须**短**：14-24 个英文单词，用逗号分隔的视觉要素（例如 "wet asphalt, yellow cordon tape, puddles, grey overcast light"），不要写成句子，超长会被图像模型的文本编码器截断。',
].join('\n');

async function deriveOne(env: Record<string, string>, s: ReturnType<typeof listScenarios>[number]): Promise<StorySceneSpec> {
  const { title, tags, text } = narrativeOf(s);
  const base: StorySceneSpec = {
    scenarioId: s.id, basis: '', place: '', scene: '', mood: 'neutral', indoor: true, valid: false,
  };
  const key = env.DEEPSEEK_API_KEY || '';
  const model = env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
  const apiBase = (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  if (!key) throw new Error('.env 缺少 DEEPSEEK_API_KEY');

  for (let attempt = 0; attempt < 2; attempt++) {
    const ask = attempt === 0
      ? text
      : text + '\n\n（上一次输出不合格：出现了人物或文字或血腥元素。请只描述空无一人的环境，重写。）';
    const r = await fetch(apiBase + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: ask }],
        max_tokens: 1200,
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!r.ok) { base.reject = 'HTTP ' + r.status; continue; }
    const j = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = j?.choices?.[0]?.message?.content || '';
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) { base.reject = 'no json'; continue; }
    let parsed: { basis?: string; place?: string; scene?: string; mood?: string; indoor?: boolean };
    try { parsed = JSON.parse(m[0]); } catch { base.reject = 'bad json'; continue; }
    const scene = String(parsed.scene || '').trim();
    if (!scene) { base.reject = 'empty scene'; continue; }
    const hit = DENY_PERSON.test(scene) ? 'person' : DENY_TEXT.test(scene) ? 'text' : DENY_GORE.test(scene) ? 'gore' : '';
    base.basis = String(parsed.basis || '').slice(0, 60);
    base.place = String(parsed.place || '').slice(0, 30);
    base.scene = scene.slice(0, 400);
    base.mood = (['cool', 'warm', 'neutral'].includes(String(parsed.mood)) ? parsed.mood : 'neutral') as StorySceneSpec['mood'];
    base.indoor = parsed.indoor !== false;
    base.model = model;
    base.derivedAt = new Date().toISOString();
    if (hit) { base.reject = 'deny:' + hit; continue; }
    base.valid = true;
    base.reject = '';
    return base;
  }
  return base;
}

async function main() {
  const args = process.argv.slice(2);
  const probe = args.includes('--probe');
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? args.slice(onlyIdx + 1) : [];
  const env = loadEnv();

  const scenarios = listScenarios('zh').filter(s => only.length === 0 || only.includes(s.id));
  console.log(`内置剧本 ${scenarios.length} 部${probe ? '（probe 模式：不调模型）' : ''}`);

  if (probe) {
    for (const s of scenarios.slice(0, 3)) {
      const { title, text } = narrativeOf(s);
      console.log(`\n===== ${s.id} / ${title}\n${text}`);
    }
    return;
  }

  // ⚠️ 落盘格式是 { generatedAt, note, items: [...] }（不是裸数组），这里踩过一次：直接 .map 会炸
  const existing: StorySceneSpec[] = (() => {
    if (!fs.existsSync(OUT_FILE)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) as unknown;
      if (Array.isArray(parsed)) return parsed as StorySceneSpec[];
      const items = (parsed as { items?: unknown })?.items;
      return Array.isArray(items) ? (items as StorySceneSpec[]) : [];
    } catch {
      return [];
    }
  })();
  const byId = new Map(existing.map(x => [x.scenarioId, x]));
  let ok = 0, bad = 0;
  for (const s of scenarios) {
    const spec = await deriveOne(env, s);
    byId.set(spec.scenarioId, spec);
    if (spec.valid) { ok++; console.log(`✓ ${s.id.padEnd(26)} ${spec.mood.padEnd(7)} ${spec.indoor ? '室内' : '室外'}  ${spec.place}｜${spec.scene.slice(0, 90)}`); }
    else { bad++; console.log(`✗ ${s.id.padEnd(26)} 未采用（${spec.reject}）→ 退回白名单兜底`); }
  }
  const all = [...byId.values()].sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
  fs.writeFileSync(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), note: '依据剧本叙事文本推导的场景规格；只处理内置剧本（用户自建剧本走白名单兜底）', items: all }, null, 2));
  console.log(`\n完成：可用 ${ok} / 未采用 ${bad} → ${OUT_FILE}`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
