param(
  [string]$OpenClaw = "$env:APPDATA\npm\openclaw.cmd",
  [string]$Agent = "main",
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $OpenClaw)) {
  throw "openclaw executable not found: $OpenClaw"
}

function Invoke-AgentJson {
  param(
    [string]$Message
  )
  $raw = & $OpenClaw agent --agent $Agent --message $Message --json --timeout $TimeoutSeconds | Out-String
  $obj = $raw | ConvertFrom-Json
  $text = [string]$obj.result.payloads[0].text
  $start = $text.IndexOf("{")
  $end = $text.LastIndexOf("}")
  if ($start -lt 0 -or $end -le $start) {
    throw "Agent reply does not contain JSON payload. Raw text: $text"
  }
  $jsonText = $text.Substring($start, $end - $start + 1)
  return ($jsonText | ConvertFrom-Json)
}

$steps = @(
  [PSCustomObject]@{
    name = "quickcheck"
    message = "Run serial_quickcheck with observeMs=1200, driveAngle=90, triggerProbe=false. Return JSON only."
  },
  [PSCustomObject]@{
    name = "nudge_left"
    message = "Run serial_intent with instruction='move a bit left', verifyMs=1200. Return JSON only."
  },
  [PSCustomObject]@{
    name = "stop"
    message = "Run serial_intent with instruction='stop the motor', verifyMs=1200. Return JSON only."
  }
)

$results = @()
foreach ($step in $steps) {
  $payload = Invoke-AgentJson -Message $step.message
  $results += [PSCustomObject]@{
    step = $step.name
    status = $payload.status
    intent = $payload.intent
    verified = $payload.verification.verified
    reason = $payload.verification.reason
    latest_servo = $payload.summary.servo.last
    imu_detected = $payload.summary.imu.detected
  }
  Start-Sleep -Milliseconds 300
}

$ok = $true
if (-not ($results | Where-Object { $_.step -eq "quickcheck" -and $_.imu_detected -eq $true })) {
  $ok = $false
}
if (-not ($results | Where-Object { $_.step -eq "nudge_left" -and $_.verified -eq $true })) {
  $ok = $false
}
if (-not ($results | Where-Object { $_.step -eq "stop" -and $_.verified -eq $true })) {
  $ok = $false
}

[PSCustomObject]@{
  type = "semantic_e2e_check"
  ok = $ok
  results = $results
} | ConvertTo-Json -Depth 6
