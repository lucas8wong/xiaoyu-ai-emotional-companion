# 小愈「剧情专属画面」出图侧车守护脚本（端口 8004）
# 每 15 秒检测一次侧车健康，挂了自动拉起；日志写入 data/
# ⚠️ 用 .venv-image（图像模型环境），**不要**用生产 TTS 的 .venv-voxcpm
# ⚠️ 只应存在一份守护实例（本项目曾出现 guard 重复实例，务必先确认没有第二份在跑）
#
# 显存提示：本侧车常驻约 8.8GB（1024x576）。与 VoxCPM TTS（约 10GB+）同卡时会互挤——
# 需要"用完就让位"时，启动前设 SCENE_ART_IDLE_UNLOAD_S=300（闲置 5 分钟自动卸载模型）。

$port = 8004
$dir = Split-Path $PSScriptRoot -Parent
$outLog = Join-Path $dir "data\scene-art.log"
$errLog = Join-Path $dir "data\scene-art-err.log"
$venvPy = Join-Path $dir ".venv-image\Scripts\python.exe"
$serverPy = Join-Path $dir "scripts\image_server.py"

function Ensure-SceneArt {
  try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
    if ($resp.StatusCode -eq 200) { return }
  } catch { }

  try {
    if (-not (Test-Path $venvPy)) {
      Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [scene-art-guard] venv python not found: $venvPy"
      return
    }
    # ⚠️ 必须直接设 $env:（子进程继承）；不要像 guard-voxcpm.ps1 那样只建 hashtable 而不传给 Start-Process（那样不生效）
    # 闲置 300s 卸载模型：本机是**生产 TTS 同卡**，常驻 8.8GB 会让 VoxCPM 抢不到显存（实测加载后 free 只剩 560MB，
    # 闲置卸载后归还 11.3GB）。首页图慢 11s 换生产 TTS 安全，值得。
    $env:SCENE_ART_IDLE_UNLOAD_S = '300'
    $env:SCENE_ART_MIN_FREE_GB = '10.5'
    $p = Start-Process -FilePath $venvPy `
      -ArgumentList $serverPy `
      -WorkingDirectory $dir -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [scene-art-guard] restarted PID=$($p.Id)"
  } catch {
    Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [scene-art-guard] restart failed: $($_.Exception.Message)"
  }
}

Write-Host "=== 剧情出图侧车守护已启动 ==="
Write-Host "每 15s 检查 http://127.0.0.1:$port/health"
Write-Host "Python: $venvPy"
Write-Host "Log: data\scene-art.log / scene-art-err.log"
while ($true) {
  Ensure-SceneArt
  Start-Sleep -Seconds 15
}
