# 空地设备只读接口；支持参数或既有环境变量覆盖地址。
param(
  [string]$CarUrl = $(if ($env:ATOMORI_CAR_URL) { $env:ATOMORI_CAR_URL } else { 'http://192.168.1.21:8765' }),
  [switch]$DisconnectCar = $true,
  # 2026-10-15 已授权恢复真实遥测；视觉按后续指令单独启用。
  [switch]$DisconnectUav,
  [switch]$EnableUavVision,
  [string]$UavHost = 'uavpi.local',
  [string]$MissionPlannerUrl = '',
  [string]$ListenAddress = '0.0.0.0'
)
$env:ATOMORI_CAR_URL = if ($DisconnectCar) { '' } else { $CarUrl }
$env:ATOMORI_LISTEN_ADDRESS = $ListenAddress
$env:ATOMORI_MISSION_PLANNER_URL = $MissionPlannerUrl
$env:ATOMORI_LIVE_ONLY = 'true'
$env:ATOMORI_UAV_VISION_URL = if ($DisconnectUav -or !$EnableUavVision) { '' } else { "http://${UavHost}:8765" }
$env:ATOMORI_UAV_FLIGHT_URL = if ($DisconnectUav) { '' } else { "http://${UavHost}:8768" }
node (Join-Path $PSScriptRoot 'src/server.js')
