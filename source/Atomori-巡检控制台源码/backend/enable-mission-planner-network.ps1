#Requires -RunAsAdministrator
param(
  [string]$MissionPlannerIp = '192.168.1.7',
  [string]$PlatformIp = '192.168.1.9'
)
$ErrorActionPreference = 'Stop'
$localPythonLauncher = Join-Path $PSScriptRoot '.venv-mavlink-local\Scripts\python.exe'
$pythonLauncher = if (Test-Path -LiteralPath $localPythonLauncher) { $localPythonLauncher } else { Join-Path $PSScriptRoot '.venv-mavlink\Scripts\python.exe' }
if (-not (Test-Path -LiteralPath $pythonLauncher)) { throw 'Mission Planner 接收环境尚未安装。' }
$udpListener = Get-NetUDPEndpoint -LocalPort 14551 -ErrorAction SilentlyContinue | Select-Object -First 1
# Windows venv 的启动器可能另起基础 Python 进程；规则匹配实际监听者。
$pythonExecutable = if ($udpListener) { (Get-Process -Id $udpListener.OwningProcess -ErrorAction Stop).Path } else { & $pythonLauncher -c 'import sys; print(sys._base_executable)' }
$webListener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$nodeExecutable = if ($webListener) { (Get-Process -Id $webListener.OwningProcess -ErrorAction Stop).Path } else { (Get-Command node -ErrorAction Stop).Source }
if (-not (Get-NetIPAddress -IPAddress $PlatformIp -ErrorAction SilentlyContinue)) { throw "本机没有地址 $PlatformIp，请先确认当前局域网 IP。" }
if (-not $pythonExecutable -or -not (Test-Path -LiteralPath $pythonExecutable)) { throw '无法定位遥测接收器的 Python 程序。' }
if (-not $nodeExecutable -or -not (Test-Path -LiteralPath $nodeExecutable)) { throw '无法定位网页服务的 Node 程序，请先启动网页服务。' }
foreach ($item in @(
  @{ Name = 'Atomori-MissionPlanner-14551'; Program = $pythonExecutable; Protocol = 'UDP'; Port = 14551 },
  @{ Name = 'Atomori-Web-3000'; Program = $nodeExecutable; Protocol = 'TCP'; Port = 3000 }
)) {
  $arguments = @{ Name = $item.Name; Direction = 'Inbound'; Action = 'Allow'; Enabled = 'True'; Profile = 'Any'; Program = $item.Program; Protocol = $item.Protocol; LocalPort = $item.Port; LocalAddress = $PlatformIp; RemoteAddress = $MissionPlannerIp }
  if (Get-NetFirewallRule -Name $item.Name -ErrorAction SilentlyContinue) {
    Set-NetFirewallRule @arguments | Out-Null
  } else {
    New-NetFirewallRule @arguments -DisplayName $item.Name | Out-Null
  }
}
Write-Host "已仅允许 $MissionPlannerIp 访问本机 $PlatformIp 的 TCP 3000 网页和 UDP 14551 遥测。"
