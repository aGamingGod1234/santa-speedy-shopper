# Starts the OpenClaw gateway for the speed run, with keys from user env vars and raw stream logging.
# Run: powershell -ExecutionPolicy Bypass -File scripts\start-gateway.ps1
foreach ($k in 'CEREBRAS_API_KEY', 'MOONSHOT_API_KEY', 'OPENCLAW_GATEWAY_TOKEN') {
  Set-Item "env:$k" ([Environment]::GetEnvironmentVariable($k, 'User'))
}
$logs = Join-Path $PSScriptRoot '..\logs'
New-Item -ItemType Directory -Force $logs | Out-Null
openclaw gateway --force --raw-stream --raw-stream-path (Join-Path $logs 'raw-stream.jsonl')
