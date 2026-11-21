# Starts the OpenClaw gateway for the speed run, with keys from user env vars.
# Run: powershell -ExecutionPolicy Bypass -File scripts\start-gateway.ps1 [-RawStream]
# -RawStream logs every token to logs\raw-stream.jsonl (debug only; leave it off for the recorded run).
param([switch]$RawStream)
foreach ($k in 'CEREBRAS_API_KEY', 'MOONSHOT_API_KEY', 'OPENCLAW_GATEWAY_TOKEN') {
  Set-Item "env:$k" ([Environment]::GetEnvironmentVariable($k, 'User'))
}
$logs = Join-Path $PSScriptRoot '..\logs'
New-Item -ItemType Directory -Force $logs | Out-Null
if ($RawStream) {
  openclaw gateway --force --raw-stream --raw-stream-path (Join-Path $logs 'raw-stream.jsonl')
} else {
  openclaw gateway --force
}
