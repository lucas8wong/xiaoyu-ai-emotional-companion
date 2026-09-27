# 小愈 VoxCPM2 TTS 侧车守护脚本
# 每 15 秒检测一次 VoxCPM 服务(8003)健康，挂了自动拉起，日志写入 data/
# 双击「启动VoxCPM守护.bat」运行；关闭本窗口 = 停止守护（服务仍会继续运行）

$port = 8003
$dir = Split-Path $PSScriptRoot -Parent
$outLog = Join-Path $dir "data\voxcpm.log"
$errLog = Join-Path $dir "data\voxcpm-err.log"
$venvPy = Join-Path $dir ".venv-voxcpm\Scripts\python.exe"
$modelDir = Join-Path $dir "voxcpm_model"
$serverPy = Join-Path $dir "scripts\voxcpm_server.py"

function Ensure-Voxcpm {
  try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
    if ($resp.StatusCode -eq 200) { return }
  } catch { }

  try {
    if (-not (Test-Path $venvPy)) {
      Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [voxcpm-guard] venv python not found: $venvPy"
      return
    }
    $envP = @{}
    $envP["VOXCPM_MODEL_DIR"] = $modelDir
    $envP["VOXCPM_PORT"] = "$port"
    $envP["VOXCPM_VOICE"] = "(quiet gentle female voice, soothe and warm tone, moderate pace)"
    $p = Start-Process -FilePath $venvPy `
      -ArgumentList $serverPy `
      -WorkingDirectory $dir -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [voxcpm-guard] voxcpm restarted PID=$($p.Id)"
  } catch {
    Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [voxcpm-guard] restart failed: $($_.Exception.Message)"
  }
}

Write-Host "=== VoxCPM2 TTS sidecar guard started ==="
Write-Host "Checking http://127.0.0.1:$port/health every 15s"
Write-Host "Model: $modelDir"
Write-Host "Log: data\voxcpm.log / voxcpm-err.log"
while ($true) {
  Ensure-Voxcpm
  Start-Sleep -Seconds 15
}
