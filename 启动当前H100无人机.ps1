param([int]$Port = 3003)
$ErrorActionPreference = 'Stop'
$entry = Join-Path $PSScriptRoot '启动H100实时图传.ps1'
& $entry -Port $Port -CarUrl '' -UavFlightUrl 'http://192.168.50.3:8768' -UavVisionUrl 'http://192.168.50.3:8765' -UavVideoUrl 'http://192.168.50.3:8870'
