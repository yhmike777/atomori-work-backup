param(
  [string]$SourceIp = '',
  [int]$UdpPort = 14551,
  [int]$HttpPort = 8770
)
$localPythonExecutable = Join-Path $PSScriptRoot '.venv-mavlink-local\Scripts\python.exe'
$pythonExecutable = if (Test-Path -LiteralPath $localPythonExecutable) { $localPythonExecutable } else { Join-Path $PSScriptRoot '.venv-mavlink\Scripts\python.exe' }
if (-not (Test-Path -LiteralPath $pythonExecutable)) {
  throw '请先执行 python -m venv .venv-mavlink，再执行 .\.venv-mavlink\Scripts\python.exe -m pip install -r device\requirements-mission-planner.txt'
}
$bridgeArguments = @((Join-Path $PSScriptRoot 'device\mission_planner_bridge.py'), '--udp-port', $UdpPort, '--http-port', $HttpPort)
if ($SourceIp) { $bridgeArguments += @('--source-ip', $SourceIp) }
& $pythonExecutable @bridgeArguments
