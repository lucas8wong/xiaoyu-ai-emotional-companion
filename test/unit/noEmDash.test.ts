import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const SCAN_DIRS = ['src', 'api', 'public', 'test', 'scripts', '.github']
const ROOT_FILES = ['index.html', 'tailwind.config.js', 'eslint.config.js']
const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cjs', '.css', '.html', '.json', '.yml', '.yaml'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-dev', 'dist-seo', '.git', 'data', 'temp', '.dsh', 'coverage', 'img', 'fonts', 'music', 'audio', 'assets', 'scenes'])

/**
 * 有意保留中文双破折号的文件：
 *   · dashText.ts / dashText.test.ts：替代口径的实现与用例，必须能写出这个符号；
 *   · chatVoice.ts：聊一聊的禁令要指名道姓写出被禁的符号（历史上正是它把提示词示范压到 ≤1 处）；
 *   · chatVoice.test.ts / chatSignal.test.ts：守卫断言里必须出现该符号；
 *   · sweep-em-dash.mts：一次性清扫脚本自身。
 */
const EXEMPT = new Set([
  'src/lib/dashText.ts',
  'test/unit/dashText.test.ts',
  'test/unit/chatVoice.test.ts',
  'test/unit/chatSignal.test.ts',
  'api/services/chatVoice.ts',
  'scripts/sweep-em-dash.mts',
])
/** 用码点拼出符号，守卫自身因此不含它，不必自我豁免 */
const DASH = '\u2014\u2014'

const hits: string[] = []

function scanFile(p: string) {
  const rel = path.relative(ROOT, p).split(path.sep).join('/')
  if (EXEMPT.has(rel)) return
  if (!EXTS.has(path.extname(p).toLowerCase())) return
  let text: string
  try { text = fs.readFileSync(p, 'utf8') } catch { return }
  if (!text.includes(DASH)) return
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes(DASH)) hits.push(rel + ':' + (i + 1) + '  ' + line.trim().slice(0, 120))
  })
}

function walk(dir: string) {
  if (!fs.existsSync(dir)) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (SKIP_DIRS.has(e.name)) continue; walk(p) }
    else if (e.isFile()) scanFile(p)
  }
}

for (const d of SCAN_DIRS) walk(path.join(ROOT, d))
for (const f of ROOT_FILES) { const p = path.join(ROOT, f); if (fs.existsSync(p)) scanFile(p) }

test('用户可见范围里不许再出现中文双破折号（防回潮守卫）', () => {
  assert.equal(
    hits.length,
    0,
    '\n发现 ' + hits.length + ' 处破折号，请改用统一替代口径（src/lib/dashText.ts），或跑 npx tsx scripts/sweep-em-dash.mts --write：\n' + hits.slice(0, 40).join('\n'),
  )
})