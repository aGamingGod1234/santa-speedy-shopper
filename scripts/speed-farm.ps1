# Unattended Speed Bounty runs: every -EveryMin minutes, run a batch of -Runs scored runs on the patched OpenClaw,
# until -Until (local time). Restarts the patched gateway if it is down. Logs to logs\speed-farm.log;
# each batch writes logs\speed-*.json. See the best with: node scripts\best-speed.mjs
# Start hidden so it survives the terminal:
#   Start-Process powershell -WindowStyle Hidden -ArgumentList '-ExecutionPolicy Bypass -File scripts\speed-farm.ps1'
# Stop: create logs\speed-farm.stop (checked before each batch), or end the powershell process.
param(
  [int]$Runs = 20,
  [int]$EveryMin = 30,
  [datetime]$Until = '2026-11-22 20:00',
  [string]$Prompt = 'prompts\santa-fast.txt'
)
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$log = Join-Path $root 'logs\speed-farm.log'
$stop = Join-Path $root 'logs\speed-farm.stop'
$node24 = 'C:\Users\User\tools\node24\node.exe'
$oc = 'C:\Users\User\openclaw-speed\openclaw.mjs'
foreach ($k in 'CEREBRAS_API_KEY', 'OPENCLAW_GATEWAY_TOKEN') { Set-Item "env:$k" ([Environment]::GetEnvironmentVariable($k, 'User')) }

function Write-Log($msg) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Add-Content -Encoding utf8 $log }
function Test-Gateway { try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', 19789); $c.Close(); $true } catch { $false } }

Write-Log "farm start: $Runs runs every $EveryMin min until $Until, prompt $Prompt (pid $PID)"
$batch = 0
while ((Get-Date) -lt $Until) {
  if (Test-Path $stop) { Write-Log 'stop file found, exiting'; break }
  if (-not (Test-Gateway)) {
    Write-Log 'gateway down, starting it'
    Start-Process $node24 -WindowStyle Hidden -ArgumentList "`"$oc`" --profile speed gateway run --force" `
      -RedirectStandardOutput (Join-Path $root 'logs\speed-gateway.out.log') -RedirectStandardError (Join-Path $root 'logs\speed-gateway.err.log')
    for ($i = 0; $i -lt 90 -and -not (Test-Gateway); $i++) { Start-Sleep 1 }
    if (-not (Test-Gateway)) { Write-Log 'gateway failed to start; retrying next round'; Start-Sleep ($EveryMin * 60); continue }
    # the port opens before the agent database is ready; a run sent right away fails
    Start-Sleep 30
  }
  $batch++
  $started = Get-Date
  $out = node scripts\speed-score.mjs --runs $Runs --gap-ms 4000 --prompt-file $Prompt --label "farm-$batch" 2>&1 | Out-String
  $summary = ($out -split "`n" | Where-Object { $_ -match '^(valid|no valid)' }) -join ' '
  $errors = ([regex]::Matches($out, 'ERROR')).Count
  Write-Log "batch ${batch}: $summary | errors $errors"
  $best = (node scripts\best-speed.mjs --top 1 | Select-Object -First 1)
  Write-Log "overall: $best"
  $wait = $started.AddMinutes($EveryMin) - (Get-Date)
  if ($wait.TotalSeconds -gt 0) { Start-Sleep ([int]$wait.TotalSeconds) }
}
Write-Log 'farm end'
