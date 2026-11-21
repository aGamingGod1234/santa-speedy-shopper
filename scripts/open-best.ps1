# Opens the best scored Speed Bounty session in the patched OpenClaw web chat, ready to screen-record.
# Run: powershell -ExecutionPolicy Bypass -File scripts\open-best.ps1 [-SessionKey agent:santa:bench-...]
# The gateway token comes from your user env var and is never printed.
param([string]$SessionKey)
if (-not $SessionKey) {
  $line = node (Join-Path $PSScriptRoot 'best-speed.mjs') --top 1 | Select-String 'best session to open in the web chat: (.+)$'
  if (-not $line) { Write-Error 'No valid runs in logs\speed-*.json yet.'; exit 1 }
  $SessionKey = $line.Matches[0].Groups[1].Value.Trim()
}
$token = [Environment]::GetEnvironmentVariable('OPENCLAW_GATEWAY_TOKEN', 'User')
Write-Host "Opening $SessionKey"
Start-Process ("http://127.0.0.1:19789/chat?session=" + [uri]::EscapeDataString($SessionKey) + "#token=" + $token)
