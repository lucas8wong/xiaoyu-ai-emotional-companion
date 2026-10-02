/**
 * 一次性清扫：把全库的「，」按统一替代口径改写。
 *
 * 用法：
 *   npx tsx scripts/sweep-em-dash.mts                        # 试运行，只报告不写盘
 *   npx tsx scripts/sweep-em-dash.mts --write                # 真正写盘
 *   npx tsx scripts/sweep-em-dash.mts --write --only=src/wenyou/scenarios
 *
 * 规则实现在 src/lib/dashText.ts（唯一口径，别在这里另写一套）。
 * 例外文件（EXEMPT）里的「，」是有意保留的：禁令原文与守卫测试必须能写出这个符号。
 */
import fs from "node:fs"
import path from "node:path"
import { rewriteEmDashLine } from "../src/lib/dashText.js"

const args = process.argv.slice(2)
const WRITE = args.includes("--write")
const onlyArg = args.find((a) => a.startsWith("--only="))
const ONLY = onlyArg ? onlyArg.slice("--only=".length) : ""

const ROOT = process.cwd()
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "dist-dev", "dist-seo", "data", "temp", ".vite", "build",
  "coverage", ".dsh", "voxcpm_model", ".venv-voxcpm", ".venv-tts", ".venv-image",
  "third_party", "pretrained_models", "vendor", "tools", "ui_shots",
])
const EXEMPT = new Set([
  "src/lib/dashText.ts",
  "test/unit/dashText.test.ts",
  "test/unit/noEmDash.test.ts",
  "test/unit/chatVoice.test.ts",
  "test/unit/chatSignal.test.ts",
  "api/services/chatVoice.ts",
])
const EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".css", ".md", ".html", ".json", ".py", ".ps1", ".yml", ".yaml", ".bat", ".vbs"])
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/")

let filesChanged = 0
let linesChanged = 0
let linesRewritten = 0
let leftover = 0
const samples: string[] = []
const changedFiles: string[] = []
const leftovers: string[] = []

function sweepFile(abs: string) {
  const r = rel(abs)
  if (EXEMPT.has(r)) return
  if (ONLY && !r.includes(ONLY)) return
  const text = fs.readFileSync(abs).toString("utf8")
  if (!text.includes("—")) return
  const hasBom = text.charCodeAt(0) === 0xFEFF
  const body = hasBom ? text.slice(1) : text
  const eol = body.includes("\r\n") ? "\r\n" : "\n"
  const lines = body.split(/\r?\n/)
  let touched = false
  const out = lines.map((line) => {
    if (!line.includes("—")) return line
    const nxt = rewriteEmDashLine(line)
    if (nxt !== line) {
      touched = true
      linesRewritten++
      if (samples.length < 80) samples.push("[" + r + "]\n  - " + line.trim().slice(0, 170) + "\n  + " + nxt.trim().slice(0, 170))
    }
    return nxt
  })
  if (!touched) return
  for (const l of out) if (l.includes("—")) { leftover++; if (leftovers.length < 20) leftovers.push(r + "  ::  " + l.trim().slice(0, 160)) }
  filesChanged++
  changedFiles.push(r)
  linesChanged += out.filter((l, i) => l !== lines[i]).length
  if (WRITE) fs.writeFileSync(abs, (hasBom ? "\uFEFF" : "") + out.join(eol), "utf8")
}

function walk(dir: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (SKIP_DIRS.has(e.name)) continue; walk(path.join(dir, e.name)) }
    else if (e.isFile() && EXT.has(path.extname(e.name).toLowerCase())) sweepFile(path.join(dir, e.name))
  }
}
walk(ROOT)
const report = (WRITE ? "WRITE" : "DRY-RUN") + "  files=" + filesChanged + "  lines changed=" + linesChanged + "  dash lines rewritten=" + linesRewritten + "  leftover=" + leftover
const reportPath = path.join(ROOT, "temp", "sweep-report.txt")
fs.mkdirSync(path.dirname(reportPath), { recursive: true })
fs.writeFileSync(reportPath, report + "\n\n=== leftovers ===\n" + leftovers.join("\n") + "\n\n=== samples ===\n" + samples.join("\n") + "\n\n=== changed files ===\n" + changedFiles.join("\n"), "utf8")
console.log(report)
console.log("report: " + reportPath)