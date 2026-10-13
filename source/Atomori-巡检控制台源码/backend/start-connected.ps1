# 空地设备只读接口；支持参数或既有环境变量覆盖地址。
param(
  [string]$CarUrl = $(if ($env:ATOMORI_CAR_URL) { $env:ATOMORI_CAR_URL } else { 'http://192.168.1.21:8765' }),
  # 用户要求暂停无人机树莓派连接；收到明确“连接”指令后才恢复。
  [switch]$DisconnectUav = $true,
  [string]$UavHost = '192.168.1.37',
  [string]$ListenAddress = '0.0.0.0'
)
$env:ATOMORI_CAR_URL = $CarUrl
$env:ATOMORI_LISTEN_ADDRESS = $ListenAddress
$env:ATOMORI_MISSION_PLANNER_URL = 'http://127.0.0.1:8770'
$env:ATOMORI_UAV_VISION_URL = if ($DisconnectUav) { '' } else { "http://${UavHost}:8765" }
$env:ATOMORI_UAV_FLIGHT_URL = if ($DisconnectUav) { '' } else { "http://${UavHost}:8768" }
node (Join-Path $PSScriptRoot 'src/server.js')
