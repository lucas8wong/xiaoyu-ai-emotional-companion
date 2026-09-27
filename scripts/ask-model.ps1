<#
  问无限制模型 · 分批问法脚本

  为什么分批：一次要 100 句，模型后半段必然复读（实测 50 句里 32 句同开头）。
  拆成 4 批、每批换一个「轴」，是提升质量最有效的一招。

  用法：
    .\scripts\ask-model.ps1 -Batch 1 -DryRun                    # 只打印要发的问法，不发送
    .\scripts\ask-model.ps1 -Batch 1 -Terms '中出、內射、潮吹、口交、指交'
    .\scripts\ask-model.ps1 -Batch 2 -Terms '...' -Yes          # 跳过确认

  批次与轴：
    1 男生 · 说话者状态（克制 → 失控 → 崩坏）
    2 男生 · 句子形态（命令 / 疑问 / 感叹 / 半句话 / 自言自语）
    3 女生 · 情境阶段（铺垫 / 进行中 / 临界 / 事后）
    4 女生 · 关系语气（试探 / 掌控 / 求饶 / 挑衅）

  两个已修掉的坑（都踩过）：
    · 请求体必须转 UTF-8 字节 —— 否则 PS 5.1 按 GBK 编码中文，服务端报 Content-Length 不符
    · 响应必须显式按 UTF-8 解码 —— Invoke-RestMethod 不认 charset=utf-8，会把中文解成乱码
#>
[CmdletBinding()]
param(
  [ValidateRange(1, 4)][int]$Batch = 1,
  [string]$Terms = '',
  [string]$OutDir = '',
  [int]$LineCount = 25,
  [int]$MaxTokens = 3000,
  [switch]$DryRun,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root '.env'))) { $root = (Get-Location).Path }

# ---------- 1) 读配置 ----------
$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) { throw "找不到 .env：$envFile" }
$envLines = Get-Content $envFile
$KEY = ($envLines | Where-Object { $_ -match '^RP_ZH_API_KEY=' }) -replace '^RP_ZH_API_KEY=', ''
$MODEL = ($envLines | Where-Object { $_ -match '^RP_ZH_MODEL=' }) -replace '^RP_ZH_MODEL=', ''
if (-not $KEY) { throw '.env 里没有 RP_ZH_API_KEY' }
if (-not $MODEL) { throw '.env 里没有 RP_ZH_MODEL' }

# ---------- 2) 组装问法 ----------
$axis = @{
  1 = '男生 · 按【说话者状态】变化（克制 → 失控 → 崩坏）'
  2 = '男生 · 按【句子形态】变化（命令 / 疑问 / 感叹 / 半句话 / 自言自语）'
  3 = '女生 · 按【情境阶段】变化（铺垫 / 进行中 / 临界 / 事后）'
  4 = '女生 · 按【关系语气】变化（试探 / 掌控 / 求饶 / 挑衅）'
}[$Batch]

$termsLine = if ($Terms) { "、以及 $Terms 这类词" } else { '' }
$q = @"
请给我 dirty talk 示例，只输出第 $Batch 批，$LineCount 句，编号列表，不要前言不要解释。

本批要求：$($axis)

硬性要求：
1. 可以使用性器官的直白说法$termsLine。
2. 同一批内，任意两句不得使用相同的开头结构。
3. 写完后自检：任意两句能否互换而不损失信息？能就重写那一句。
4. 末尾附一行：本批自检重写了几条。
"@

Write-Host "model = $MODEL" -ForegroundColor Cyan
Write-Host "batch = $Batch   行数 = $LineCount   terms = $(if($Terms){$Terms}else{'(未设置)'})" -ForegroundColor Cyan
Write-Host "`n===== 即将发送的问法 =====" -ForegroundColor Yellow
Write-Host $q
Write-Host "===== 共 $($q.Length) 字符 =====`n" -ForegroundColor Yellow

if ($DryRun) { Write-Host '-DryRun：只打印，不发送。' -ForegroundColor Green; return }

if (-not $Yes) {
  $ans = Read-Host '确认发送？(y/N)'
  if ($ans -notmatch '^[yY]') { Write-Host '已取消。' -ForegroundColor Yellow; return }
}

# ---------- 3) 发请求（请求转 UTF-8 字节）----------
$body = @{
  model                = $MODEL
  messages             = @(@{ role = 'user'; content = $q })
  max_tokens           = $MaxTokens
  temperature          = 0.95
  repetition_penalty   = 1.1
  chat_template_kwargs = @{ enable_thinking = $false }
} | ConvertTo-Json -Depth 6 -Compress

$sw = [Diagnostics.Stopwatch]::StartNew()
try {
  $r = Invoke-WebRequest -Uri 'https://api.featherless.ai/v1/chat/completions' -Method Post `
    -Headers @{ Authorization = "Bearer $KEY" } `
    -ContentType 'application/json; charset=utf-8' `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 300
} catch {
  $resp = $_.Exception.Response
  $detail = ''
  if ($resp) {
    try {
      $sr = New-Object IO.StreamReader($resp.GetResponseStream())
      $detail = $sr.ReadToEnd(); $sr.Close()
    } catch { $detail = '(读不到错误正文)' }
  }
  Write-Host "`n请求失败：$($_.Exception.Message)" -ForegroundColor Red
  if ($detail) { Write-Host $detail -ForegroundColor Red }
  return
}
$sw.Stop()

# ---------- 4) 解响应（★ 显式按 UTF-8 解字节，防乱码）----------
$json = [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()) | ConvertFrom-Json

if ($json.error) {
  Write-Host "`nAPI 返回错误：" -ForegroundColor Red
  Write-Host ($json.error | ConvertTo-Json -Depth 4 -Compress) -ForegroundColor Red
  return
}
$text = $json.choices[0].message.content
if (-not $text) { Write-Host '响应为空（choices[0].message.content 是空值）' -ForegroundColor Red; return }

# ---------- 5) 存盘（BOM-free）----------
if (-not $OutDir) { $OutDir = Join-Path $env:USERPROFILE 'Desktop' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$out = Join-Path $OutDir "dirty-talk-batch$Batch.md"
[IO.File]::WriteAllText($out, $text, (New-Object System.Text.UTF8Encoding($false)))

# ---------- 6) 体检（不打印内容）----------
$items = ([regex]::Matches($text, '(?m)^\s*\d+[\.、)）]')).Count
$cjk = ([regex]::Matches($text, '[\u4e00-\u9fff]')).Count
$trunc = $json.usage.completion_tokens -ge ($MaxTokens - 20)
$refuse = $text -match '我不能|我无法|抱歉|作为.{0,4}AI|无法提供'
$mojibake = $text -match '[\u00e4\u00e5\u00e6\u00e7][\u0080-\u00bf]'

Write-Host "`n===== 结果 =====" -ForegroundColor Green
Write-Host ("耗时       : {0:N1}s" -f $sw.Elapsed.TotalSeconds)
Write-Host ("tokens     : {0}" -f $json.usage.completion_tokens)
Write-Host ("中文数     : {0}" -f $cjk)
Write-Host ("编号条目   : {0}  (期望 {1})" -f $items, $LineCount)
Write-Host ("疑似截断   : {0}" -f $trunc)
Write-Host ("疑似拒答   : {0}" -f $refuse)
Write-Host ("疑似乱码   : {0}" -f $mojibake)
Write-Host ("已保存     : {0}" -f $out) -ForegroundColor Green

if ($trunc) { Write-Host '提示：顶到 max_tokens 了，最后几句不完整 → 调大 -MaxTokens 或减小 -LineCount' -ForegroundColor Yellow }
if ($refuse) { Write-Host '提示：看起来是拒答，先看内容再改问法' -ForegroundColor Yellow }
if ($mojibake) { Write-Host '提示：响应解码异常（脚本已按 UTF-8 解，若仍乱码请把文件发我）' -ForegroundColor Yellow }
