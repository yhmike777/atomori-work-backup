# 使用本包源码启动巡检平台，仅接入无人车数据。
param(
    [ValidateRange(1, 65535)][int]$Port = 3000,
    [string]$CarUrl = 'http://192.168.1.21:8765',
    [string]$ListenAddress = '127.0.0.1'
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw '请先安装 Node.js 20 或更高版本，并重新打开 PowerShell。'
}
$projectRoot = Join-Path $PSScriptRoot 'source/Atomori-巡检控制台源码'
$env:PORT = [string]$Port
$env:ATOMORI_DATA_FILE = Join-Path $projectRoot 'backend/data/records.json'
$entry = Join-Path $projectRoot 'backend/start-connected.ps1'
& $entry -DisconnectCar:$false -DisconnectUav -CarUrl $CarUrl -ListenAddress $ListenAddress
