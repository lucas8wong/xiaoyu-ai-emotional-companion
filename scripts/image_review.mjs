#!/usr/bin/env node
/**
 * 图片视觉复核 / 内容抽检（spike 工具 · 同时是方案 §4.4「出图后抽检」的可跑原型）
 *
 * 用途一：脚本化批量复核，逐张问**项目自己的模型**（DEEPSEEK_MODEL，默认 deepseek-v4-flash：
 *         图片与文本自 2026-09-18 起同一模型，实测它直接接受 image_url 内容块并正确读图），
 *         输出 JSON 便于一次判定几十张，确认"确实出了一张合理的场景图"而不是噪声/纯色。
 * 用途二：产品化原型，实时出图落库前跑同一套判定，命中违规（人物特写/裸露/暴力/文字水印）即丢弃。
 *
 * 用法：
 *   node scripts/image_review.mjs temp/image-spike/sd-turbo-512-4step-r1.png
 *   node scripts/image_review.mjs temp/image-spike/*.png --json
 *   node scripts/image_review.mjs a.png --question "画面里有没有出现人？"
 *
 * 依赖：.env 里的 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL（值不打印、不外传）。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// ⚠️ 必须用 fileURLToPath：本项目路径含中文（「角色扮演-情绪」），
// 直接用 new URL(import.meta.url).pathname 会拿到百分号编码路径 → 找不到 .env。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 极简 .env 读取（只取需要的键；不打印任何值） */
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

const DEFAULT_QUESTION = [
  '你是图像内容审核与画面描述助手。看图后只输出一个 JSON 对象，不要任何多余文字：',
  '{',
  '  "description": "一句话中文描述画面（主体/场景/光线/色调/构图）",',
  '  "is_meaningful_image": true/false,   // false = 纯色/噪声/明显崩坏',
  '  "quality_1_5": 1-5,                  // 作为「剧情场景插画」的可用度',
  '  "has_person": true/false,            // 出现清晰人物/人脸/身体特写',
  '  "nudity": true/false,',
  '  "violence_or_gore": true/false,',
  '  "text_or_watermark": true/false,',
  '  "verdict": "pass" | "review" | "reject"',
  '}',
].join('\n');

function parseArgs(argv) {
  const files = [];
  let question = DEFAULT_QUESTION;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--question') question = argv[++i];
    else files.push(a);
  }
  return { files, question, json };
}

async function reviewOne(env, file, question) {
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
  if (!fs.existsSync(abs)) return { file, error: 'file not found' };
  const ext = path.extname(abs).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return { file, error: `unsupported ext ${ext}` };

  const b64 = fs.readFileSync(abs).toString('base64');
  const base = (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: question },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        ],
      },
    ],
    max_tokens: 4000, // ⚠️ 本脚本不传 thinking 字段 → 上游默认会思考、reasoning token 也算进 max_tokens：太小会被吃光 → content 为空（实测 700 常丢、2000 偶发、4000 稳定）
  };

  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_API_KEY || ''}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    return { file: path.relative(ROOT, abs), error: `request failed: ${e?.name || e}` };
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    return { file: path.relative(ROOT, abs), error: `HTTP ${resp.status}: ${txt.slice(0, 200)}` };
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content || '';
  let parsed = null;
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { parsed = JSON.parse(m[0]); } catch { /* 保留原文 */ } }
  return {
    file: path.relative(ROOT, abs),
    seconds: Number(elapsed),
    size_kb: Math.round(fs.statSync(abs).size / 1024),
    usage: data?.usage,
    review: parsed,
    raw: parsed ? undefined : text.slice(0, 600),
  };
}

const { files, question, json } = parseArgs(process.argv.slice(2));
if (files.length === 0) {
  console.error('用法: node scripts/image_review.mjs <图片路径...> [--json] [--question "..."]');
  process.exit(2);
}
const env = loadEnv();
if (!env.DEEPSEEK_API_KEY) {
  console.error('❌ .env 缺少 DEEPSEEK_API_KEY（或 .env 不存在）');
  process.exit(2);
}

const results = [];
for (const f of files) {
  const r = await reviewOne(env, f, question);
  results.push(r);
  if (!json) {
    if (r.error) console.log(`❌ ${r.file} → ${r.error}`);
    else if (r.review) {
      const v = r.review;
      console.log(`✓ ${r.file}  ${r.size_kb}KB  ${r.seconds}s`);
      console.log(`   描述: ${v.description}`);
      console.log(`   可用度 ${v.quality_1_5}/5 | 有意义图=${v.is_meaningful_image} | 有人物=${v.has_person} | 裸露=${v.nudity} | 暴力=${v.violence_or_gore} | 文字水印=${v.text_or_watermark}`);
      console.log(`   判定: ${v.verdict}`);
    } else console.log(`⚠️ ${r.file} → 未解析出 JSON：${r.raw}`);
  }
}
if (json) console.log(JSON.stringify(results, null, 2));
