/**
 * 日志隐私检查脚本（P1-04 回归守卫）
 * 扫描后端关键文件中「console.* 直接输出用户内容」的模式（行级启发式），
 * 命中即 exit 1 并列出违规行。用于 CI / 提交前快速自检。
 *
 * 用法：node scripts/check-log-privacy.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// 行级启发式
// ① 强模式：无论是否带 .length 都视为泄露
const STRONG = [
  /提示词[:：]/,                    // 提示词全文
  /with prompt:/,
  /query=\$?\{?query/,              // 搜索词原文
  /\.substring\(0,\s*(50|100)\)/,   // 用户内容截断打印
  /data:image\/[^)]*base64/,        // 图片 base64 进日志
];
// ② 用户内容变量：允许「仅取 .length/计数」的度量日志，其余用法视为泄露
const USER_VARS = /\b(emotionText|rawInput|answersText|parsedResult|defaultResult)\b/;

const FILES = [
  'api/services/gemini.ts',
  'api/services/deepseek.ts',
  'api/services/roleplay.ts',
  'api/routes/analysis.ts',
];

let violations = 0;
for (const rel of FILES) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, idx) => {
    if (!/console\.(log|warn|error)/.test(line)) return;
    const strongHit = STRONG.some((re) => re.test(line));
    const varHit = USER_VARS.test(line) && !line.includes('.length');
    if (strongHit || varHit) {
      console.log(`⚠️  ${rel}:${idx + 1}: ${line.trim().slice(0, 160)}`);
      violations += 1;
    }
  });
}

if (violations > 0) {
  console.log(`\n❌ 发现 ${violations} 处疑似用户内容日志（P1-04 回归失败）`);
  process.exit(1);
} else {
  console.log('✅ 日志隐私检查通过：未发现用户内容直接进 console.*');
}
