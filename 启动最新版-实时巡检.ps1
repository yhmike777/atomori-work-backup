# 实时只读巡检：车端、Mission Planner 飞控转发和独立机载视觉；缺失数据不回退演示。
param(
  [string]$CarUrl = 'http://192.168.1.21:8765',
  [switch]$DisconnectCar = $true,
  [string]$UavHost = 'uavpi.local',
  [string]$MissionPlannerUrl = 'http://127.0.0.1:8770',
  [string]$MissionPlannerSourceIp = '192.168.1.7',
  [int]$Port = 3001
)
$ErrorActionPreference = 'Stop'
$env:PORT = "$Port"
# 独立实例使用一份首次复制的业务记录，避免和原 3000 进程同时写同一 JSON。
$recordDirectory = Join-Path $PSScriptRoot '.runtime'
New-Item -ItemType Directory -Path $recordDirectory -Force | Out-Null
$env:ATOMORI_DATA_FILE = Join-Path $recordDirectory 'records.json'
if (!(Test-Path -LiteralPath $env:ATOMORI_DATA_FILE)) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'source\Atomori-巡检控制台源码\backend\data\records.json') -Destination $env:ATOMORI_DATA_FILE
}
$entry = Join-Path $PSScriptRoot 'source\Atomori-巡检控制台源码\backend\start-connected.ps1'
if ($MissionPlannerUrl.TrimEnd('/') -eq 'http://127.0.0.1:8770') {
  $receiverReady = $false
  try {
    $receiverStatus = Invoke-RestMethod -Uri "$MissionPlannerUrl/api/status" -TimeoutSec 2
    $receiverReady = $receiverStatus.source -eq 'mission-planner-mavlink'
  } catch { }
  if (!$receiverReady) {
    if (Get-NetTCPConnection -LocalPort 8770 -State Listen -ErrorAction SilentlyContinue) {
      throw '8770 端口被其他服务占用，无法启动飞控接收器。'
    }
    $receiverEntry = Join-Path (Split-Path $entry) 'start-mission-planner.ps1'
    $receiverShell = (Get-Process -Id $PID).Path
    Start-Process -FilePath $receiverShell -ArgumentList @('-NoProfile', '-File', ('"' + $receiverEntry + '"'), '-SourceIp', $MissionPlannerSourceIp) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $recordDirectory 'mission-planner.stdout.log') -RedirectStandardError (Join-Path $recordDirectory 'mission-planner.stderr.log') | Out-Null
    for ($attempt = 0; $attempt -lt 10 -and !$receiverReady; $attempt++) {
      Start-Sleep -Milliseconds 300
      try {
        $receiverStatus = Invoke-RestMethod -Uri "$MissionPlannerUrl/api/status" -TimeoutSec 2
        $receiverReady = $receiverStatus.source -eq 'mission-planner-mavlink'
      } catch { }
    }
    if (!$receiverReady) { throw '飞控接收器未启动，请检查 .runtime/mission-planner.stderr.log。' }
  }
}
& $entry -DisconnectCar:$DisconnectCar -EnableUavVision -CarUrl $CarUrl -UavHost $UavHost -MissionPlannerUrl $MissionPlannerUrl -ListenAddress '127.0.0.1'
