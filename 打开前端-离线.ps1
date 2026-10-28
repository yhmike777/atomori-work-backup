param([int]$Port = 3003)
$ErrorActionPreference = 'Stop'
$env:PORT = "$Port"
$env:ATOMORI_LISTEN_ADDRESS = '127.0.0.1'
$env:ATOMORI_LIVE_ONLY = 'true'
$env:ATOMORI_CAR_URL = ''
$env:ATOMORI_UAV_VIDEO_URL = ''
$env:ATOMORI_UAV_VISION_URL = ''
$env:ATOMORI_UAV_FLIGHT_URL = ''
$env:ATOMORI_MISSION_PLANNER_URL = ''
$env:ATOMORI_DATA_FILE = Join-Path $PSScriptRoot '.runtime\records.json'
$backendPath = Join-Path $PSScriptRoot 'source\Atomori-巡检控制台源码\backend'
New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot '.runtime') -Force | Out-Null
if (!(Test-Path -LiteralPath $env:ATOMORI_DATA_FILE)) {
  Copy-Item -LiteralPath (Join-Path $backendPath 'data\records.json') -Destination $env:ATOMORI_DATA_FILE
}
Write-Host "Frontend: http://127.0.0.1:$Port/"
node (Join-Path $backendPath 'src\server.js')
