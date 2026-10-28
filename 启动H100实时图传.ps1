# Video-only connection through the H100 Ethernet network.
param(
  [string]$CarUrl = 'http://192.168.50.2:8765',
  [string]$UavVisionUrl = '',
  [string]$UavFlightUrl = '',
  [string]$MissionPlannerUrl = '',
  [int]$Port = 3001
)
$ErrorActionPreference = 'Stop'
$runtimePath = Join-Path $PSScriptRoot '.runtime'
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
$recordsPath = Join-Path $runtimePath 'records.json'
$backendPath = Join-Path $PSScriptRoot 'source\Atomori-巡检控制台源码\backend'
if (!(Test-Path -LiteralPath $recordsPath)) {
  Copy-Item -LiteralPath (Join-Path $backendPath 'data\records.json') -Destination $recordsPath
}
$h100Addresses = @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | ForEach-Object {
  if ($_.OperationalStatus -eq 'Up') {
    $_.GetIPProperties().UnicastAddresses | ForEach-Object { $_.Address.ToString() }
  }
})
if (!($h100Addresses | Where-Object { $_ -like '192.168.50.*' })) {
  throw 'H100 Ethernet IPv4 is missing. Configure the wired adapter in 192.168.50.0/24 before starting.'
}
$env:PORT = "$Port"
$env:ATOMORI_LISTEN_ADDRESS = '127.0.0.1'
$env:ATOMORI_DATA_FILE = $recordsPath
$env:ATOMORI_LIVE_ONLY = 'true'
$env:ATOMORI_CAR_URL = $CarUrl
$env:ATOMORI_UAV_VISION_URL = $UavVisionUrl
$env:ATOMORI_UAV_FLIGHT_URL = $UavFlightUrl
$env:ATOMORI_MISSION_PLANNER_URL = $MissionPlannerUrl
# A8 video is relayed by the car gateway to http://192.168.50.3:8870/stream.
# Leave OV9281 and flight sources unconfigured until explicitly requested.
node (Join-Path $backendPath 'src\server.js')
