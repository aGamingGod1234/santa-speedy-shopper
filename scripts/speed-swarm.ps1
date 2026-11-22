# Runs -Workers parallel Speed Bounty workers (scripts\speed-score.mjs) until -Until, staggered so they don't
# hit the gateway at once. Each worker logs to its own logs\speed-*.json. Stays well under the hackathon's
# 50K uncached TPM: a run is ~3-4K uncached tokens and takes about a minute while the queue is long.
# Start hidden: Start-Process powershell -WindowStyle Hidden -ArgumentList '-ExecutionPolicy Bypass -File scripts\speed-swarm.ps1'
# Stop: end the node processes whose command line contains "--label swarm-".
param([int]$Workers = 4, [string]$Until = '2026-11-22T20:00+08:00', [int]$WarmupSec = 30)
Set-Location (Split-Path $PSScriptRoot -Parent)
foreach ($k in 'CEREBRAS_API_KEY', 'OPENCLAW_GATEWAY_TOKEN') { Set-Item "env:$k" ([Environment]::GetEnvironmentVariable($k, 'User')) }
Start-Sleep $WarmupSec   # a fresh gateway opens its port before the agent database is ready
foreach ($n in 1..$Workers) {
  Start-Process node -WindowStyle Hidden -ArgumentList "scripts\speed-score.mjs --runs 100000 --gap-ms 2000 --prompt-file prompts\santa-fast.txt --label swarm-$n --until $Until"
  Start-Sleep 8
}
