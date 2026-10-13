#Requires -RunAsAdministrator
param(
  [Parameter(Mandatory = $true)][string[]]$MissionPlannerIps,
  [Parameter(Mandatory = $true)][string]$PlatformIp
)
$ErrorActionPreference = 'Stop'
if (-not (Get-NetIPAddress -IPAddress $PlatformIp -ErrorAction SilentlyContinue)) {
  throw "本机没有地址 $PlatformIp。"
}
$listener = Get-NetUDPEndpoint -LocalPort 14551 -ErrorAction Stop | Select-Object -First 1
if (-not $listener) { throw '请先启动 Mission Planner 接收器。' }
$receiverProgram = (Get-Process -Id $listener.OwningProcess -ErrorAction Stop).Path
$arguments = @{
  Name = 'Atomori-MissionPlanner-14551'; Direction = 'Inbound'; Action = 'Allow'
  Enabled = 'True'; Profile = 'Any'; Program = $receiverProgram; Protocol = 'UDP'
  LocalPort = 14551; LocalAddress = $PlatformIp; RemoteAddress = $MissionPlannerIps
}
if (Get-NetFirewallRule -Name $arguments.Name -ErrorAction SilentlyContinue) {
  Set-NetFirewallRule @arguments | Out-Null
} else {
  New-NetFirewallRule @arguments -DisplayName $arguments.Name | Out-Null
}
Write-Host "已允许 $($MissionPlannerIps -join ', ') 向本机 ${PlatformIp}:14551/UDP 转发遥测。"
