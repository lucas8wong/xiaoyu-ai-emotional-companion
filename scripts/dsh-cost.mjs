#!/usr/bin/env node
/**
 * DSH API 花费统计工具（DeepSeek Harness 写代码的 API 花费）
 *
 * 读取 ~/.dsh/sessions 下各会话目录的 session.jsonl.zstd（DSH 会话日志），汇总每次 LLM 调用的
 * 提供方 token 用量（输入 / 缓存读取 / 输出 / 推理），并按 DeepSeek 价格折算金额。
 *
 * 用法：
 *   node scripts/dsh-cost.mjs               # 汇总全部会话
 *   node scripts/dsh-cost.mjs --days 7      # 只统计近 7 天
 *   node scripts/dsh-cost.mjs --cwd 小愈    # 只统计工作目录路径包含「小愈」的会话
 *   node scripts/dsh-cost.mjs --top 5       # 按会话明细只显示前 5 个
 *   node scripts/dsh-cost.mjs --json        # JSON 输出（供脚本/控制台程序化使用）
 *
 * 价格（USD / 每百万 tokens，可经环境变量覆盖为你的实际价）：
 *   DSH_PRICE_V4_PRO_IN / DSH_PRICE_V4_PRO_CACHE / DSH_PRICE_V4_PRO_OUT
 *   DSH_PRICE_V4_FLASH_IN / DSH_PRICE_V4_FLASH_CACHE / DSH_PRICE_V4_FLASH_OUT
 *   DSH_COST_FX        # USD→CNY 汇率（默认 7.2）
 * 默认值参考 DeepSeek V4 官方定价（2026-04 发布价；2026-08 已调价，以官方控制台为准）。
 * 注意：DSH 本身只记录 token，不折算金额；本工具的价格是估算，账目以 DeepSeek 控制台为准。
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ZSTD_MAGIC = 4247762216; // 0x28B52FFD

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

const PRICES = {
  'deepseek-v4-pro': {
    input: num(process.env.DSH_PRICE_V4_PRO_IN, 1.74),
    cache: num(process.env.DSH_PRICE_V4_PRO_CACHE, 0.145),
    output: num(process.env.DSH_PRICE_V4_PRO_OUT, 3.48),
  },
  'deepseek-v4-flash': {
    input: num(process.env.DSH_PRICE_V4_FLASH_IN, 0.14),
    cache: num(process.env.DSH_PRICE_V4_FLASH_CACHE, 0.028),
    output: num(process.env.DSH_PRICE_V4_FLASH_OUT, 0.28),
  },
};
const DEFAULT_MODEL = 'deepseek-v4-flash';
const FX = num(process.env.DSH_COST_FX, 7.2);

function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('corrupt zstd frame magic');
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error('reserved frame-header bit');
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error('reserved block type');
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

function decodeAll(buf) {
  const { frames } = scanZstdFrames(buf);
  let plain = '';
  for (const f of frames) {
    plain += zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf-8');
  }
  return plain.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function parseArgs(argv) {
  const a = { days: null, cwd: null, top: 10, json: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--json') a.json = true;
    else if (k === '--days') a.days = num(argv[++i], 7);
    else if (k === '--cwd') a.cwd = argv[++i];
    else if (k === '--top') a.top = num(argv[++i], 10);
    else { console.error('未知参数: ' + k); process.exit(1); }
  }
  return a;
}

function fmtUsd(v) { return '$' + v.toFixed(2); }
function fmtCny(v) { return '¥' + (v * FX).toFixed(2); }

const args = parseArgs(process.argv);
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const sessionsRoot = path.join(dshHome, 'sessions');

function collectSessionFiles(root, out = []) {
  if (!fs.existsSync(root)) return out;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) collectSessionFiles(full, out);
    else if (e.name === 'session.jsonl.zstd') out.push(full);
  }
  return out;
}

const files = collectSessionFiles(sessionsRoot);
const cutoff = args.days ? Date.now() - args.days * 86400000 : 0;

// 汇总结构
const modelAgg = {};          // model -> {input, cache, output, calls}
const dayAgg = {};            // YYYY-MM-DD -> usd
const sessionRows = [];       // 每个会话一行
let totalUsd = 0, totalCalls = 0;

for (const file of files) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { continue; }
  // 先读第一帧（session header）快速判断范围
  let meta = null;
  try {
    const { frames } = scanZstdFrames(buf, 1);
    if (frames.length) {
      const first = JSON.parse(zlib.zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf-8'));
      meta = { cwd: first.cwd || '', createdAt: first.createdAt || 0, id: first.id || path.basename(path.dirname(file)) };
    }
  } catch { /* 跳过损坏文件 */ }
  if (!meta) continue;
  if (args.cwd && !String(meta.cwd).includes(args.cwd)) continue;
  if (cutoff && meta.createdAt && meta.createdAt < cutoff) continue;

  let rows;
  try { rows = decodeAll(buf); } catch { continue; }

  let curModel = DEFAULT_MODEL, title = '';
  const s = { id: meta.id, cwd: meta.cwd, title: '', start: meta.createdAt, model: {}, usd: 0, calls: 0 };
  for (const ev of rows) {
    if (ev.type === 'session/title' && ev.data) {
      title = typeof ev.data === 'string' ? ev.data : (ev.data.title || ev.data.text || '');
    } else if (ev.type === 'request/header' && ev.data?.header?.config?.model) {
      curModel = ev.data.header.config.model;
    } else if (ev.type === 'assistant/chunk' && ev.data?.chunk?.type === 'usage' && ev.data.chunk.usage) {
      const u = ev.data.chunk.usage;
      const m = PRICES[curModel] || PRICES[DEFAULT_MODEL];
      const input = u.inputTokens || 0;
      const cache = u.cacheReadTokens || 0;
      const output = u.outputTokens || 0;
      const usd = (input / 1e6) * m.input + (cache / 1e6) * m.cache + (output / 1e6) * m.output;
      const mm = (modelAgg[curModel] ||= { input: 0, cache: 0, output: 0, calls: 0 });
      mm.input += input; mm.cache += cache; mm.output += output; mm.calls++;
      const sm = (s.model[curModel] ||= { input: 0, cache: 0, output: 0, calls: 0 });
      sm.input += input; sm.cache += cache; sm.output += output; sm.calls++;
      s.usd += usd; s.calls++;
      totalCalls++; totalUsd += usd;
      const day = new Date(ev.time || Date.now()).toISOString().slice(0, 10);
      dayAgg[day] = (dayAgg[day] || 0) + usd;
    }
  }
  s.title = title;
  sessionRows.push(s);
}

sessionRows.sort((a, b) => b.start - a.start);

if (args.json) {
  const byModel = {};
  for (const [m, v] of Object.entries(modelAgg)) byModel[m] = { ...v, usd: (v.input / 1e6) * (PRICES[m] || PRICES[DEFAULT_MODEL]).input + (v.cache / 1e6) * (PRICES[m] || PRICES[DEFAULT_MODEL]).cache + (v.output / 1e6) * (PRICES[m] || PRICES[DEFAULT_MODEL]).output };
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    scope: { days: args.days, cwd: args.cwd },
    prices: PRICES, fx: FX,
    totals: { calls: totalCalls, usd: Math.round(totalUsd * 100) / 100, cny: Math.round(totalUsd * FX * 100) / 100, byModel },
    byDay: Object.entries(dayAgg).sort().map(([d, v]) => ({ day: d, usd: Math.round(v * 100) / 100 })),
    sessions: sessionRows.map((s) => ({
      id: s.id, title: s.title, cwd: s.cwd,
      start: s.start ? new Date(s.start).toISOString() : null,
      calls: s.calls, usd: Math.round(s.usd * 100) / 100,
      byModel: Object.fromEntries(Object.entries(s.model).map(([m, v]) => [m, { ...v, usd: Math.round(((v.input / 1e6) * (PRICES[m] || PRICES[DEFAULT_MODEL]).input + (v.cache / 1e6) * (PRICES[m] || PRICES[DEFAULT_MODEL]).cache + (v.output / 1e6) * (PRICES[m] || PRICES[DEFAULT_MODEL]).output) * 100) / 100 }])),
    })),
  }, null, 2));
  process.exit(0);
}

console.log('════════ DSH API 花费统计 ════════');
console.log('会话目录: ' + sessionsRoot);
console.log('范围: ' + (args.days ? '近 ' + args.days + ' 天' : '全部') + (args.cwd ? ' · 工作目录含「' + args.cwd + '」' : '') + ' · 会话 ' + sessionRows.length + ' 个 / 调用 ' + totalCalls + ' 次');
console.log('');
console.log('按模型（tokens / USD / ≈CNY）：');
for (const [m, v] of Object.entries(modelAgg)) {
  const p = PRICES[m] || PRICES[DEFAULT_MODEL];
  const usd = (v.input / 1e6) * p.input + (v.cache / 1e6) * p.cache + (v.output / 1e6) * p.output;
  console.log('  ' + m.padEnd(18) + '输入 ' + Math.round(v.input / 1000) + 'k · 缓存 ' + Math.round(v.cache / 1000) + 'k · 输出 ' + Math.round(v.output / 1000) + 'k · ' + fmtUsd(usd) + ' ≈ ' + fmtCny(usd));
}
console.log('');
console.log('合计: ' + fmtUsd(totalUsd) + ' ≈ ' + fmtCny(totalUsd) + '（按 USD→CNY ' + FX + '）');
console.log('按天: ' + Object.entries(dayAgg).sort().map(([d, v]) => d + ' ' + fmtUsd(v)).join(' · '));
console.log('');
console.log('按会话（近 ' + args.top + ' 个，按开始时间倒序）：');
for (const s of sessionRows.slice(0, args.top)) {
  const d = s.start ? new Date(s.start).toISOString().slice(0, 10) : '?';
  const t = (s.title || path.basename(s.cwd || '') || s.id).slice(0, 40);
  console.log('  ' + d + '  ' + t.padEnd(42) + ' ' + s.calls + ' 次 ' + fmtUsd(s.usd));
}
console.log('');
console.log('⚠️  价格默认取 DeepSeek V4 发布价（估算），可用 DSH_PRICE_* 环境变量覆盖为你的实际价；账目以 DeepSeek 控制台为准。');
