param(
  [string]$SourceIp = '',
  [int]$UdpPort = 14551,
  [int]$HttpPort = 8770
)
$localPythonExecutable = Join-Path $PSScriptRoot '.venv-mavlink-local\Scripts\python.exe'
$pythonExecutable = if (Test-Path -LiteralPath $localPythonExecutable) { $localPythonExecutable } else { Join-Path $PSScriptRoot '.venv-mavlink\Scripts\python.exe' }
if (-not (Test-Path -LiteralPath $pythonExecutable)) {
  # 最新源码副本复用工作区原接收器依赖，仍使用本机 Python 以匹配已有入站规则。
  $sharedModules = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..\source\Atomori-巡检控制台源码\backend\.venv-mavlink\Lib\site-packages'))
  if (-not (Test-Path -LiteralPath (Join-Path $sharedModules 'pymavlink'))) {
    throw '请先执行 python -m venv .venv-mavlink，再执行 .\.venv-mavlink\Scripts\python.exe -m pip install -r device\requirements-mission-planner.txt'
  }
  $pythonExecutable = (Get-Command python -ErrorAction Stop).Source
  $env:PYTHONPATH = $sharedModules
}
$bridgeArguments = @((Join-Path $PSScriptRoot 'device\mission_planner_bridge.py'), '--udp-port', $UdpPort, '--http-port', $HttpPort)
if ($SourceIp) { $bridgeArguments += @('--source-ip', $SourceIp) }
& $pythonExecutable @bridgeArguments
