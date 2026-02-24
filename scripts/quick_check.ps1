param(
  [Parameter(Mandatory = $false)]
  [string]$TargetHost = "127.0.0.1",

  [Parameter(Mandatory = $false)]
  [int]$TelemetryPort = 9000,

  [Parameter(Mandatory = $false)]
  [int]$ControlPort = 9001,

  [Parameter(Mandatory = $false)]
  [int]$TimeoutMs = 600,

  [Parameter(Mandatory = $false)]
  [switch]$Json
)

$ErrorActionPreference = "Stop"

$nodeCandidates = @(
  (Join-Path $env:ProgramFiles "nodejs\node.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"),
  (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe")
) | Where-Object { $_ -and $_.Trim().Length -gt 0 }

$nodeExe = $null
foreach ($candidate in $nodeCandidates) {
  if (Test-Path -LiteralPath $candidate) {
    $nodeExe = $candidate
    break
  }
}

if (-not $nodeExe) {
  throw "node.exe not found in known locations. Install Node.js or set PATH, then retry."
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$scriptPath = Join-Path $repoRoot "scripts\quick_self_check.js"

if (-not (Test-Path -LiteralPath $scriptPath)) {
  throw "quick_self_check.js not found: $scriptPath"
}

$args = @(
  $scriptPath,
  "--host",
  $TargetHost,
  "--telemetry-port",
  "$TelemetryPort",
  "--control-port",
  "$ControlPort",
  "--timeout-ms",
  "$TimeoutMs"
)

if ($Json) {
  $args += "--json"
}

& $nodeExe @args
exit $LASTEXITCODE
