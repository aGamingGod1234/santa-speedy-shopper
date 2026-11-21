# Speed Bounty run (Santa's Speedy Shopper)

## Setup already done (Sat 21 Nov)
- OpenClaw 2026.11.6, config at `~/.openclaw/openclaw.json`.
- Keys are Windows user env vars: `CEREBRAS_API_KEY`, `MOONSHOT_API_KEY`, `OPENCLAW_GATEWAY_TOKEN`.
- Lean agent `santa`: empty workspace with `skipBootstrap` (no "Bootstrap Pending" block in the prompt), no skills,
  memory plugin off, minimal tools with `gateway`, `presence` and `session_status` denied, Tool Search off,
  one MCP tool `gifts__find_gifts` (`tools/gift-search-mcp.mjs`) that searches Shop MCP for all people in parallel.
  Image URLs are left out of the tool output unless `GIFT_INCLUDE_IMAGES=1` (the app sets it; the speed run doesn't need them).
  The workspace's old bootstrap files are in `~/.openclaw/workspace-santa-bootstrap-backup/`; the config before the audit is `openclaw.json.bak-pre-audit`.
- Kimi on Cerebras `maxTokens` 8192 so high reasoning can't truncate the answer.
- Providers: `cerebras/moonshotai-kimi-k3.1-pro-trial` (fast), `moonshot/kimi-k3.1-pro` (GPU comparison, ~27 tok/s, ~$9 credit).

## At kickoff
1. Check Kimi access: `$env:CEREBRAS_MODEL='moonshotai-kimi-k3.1-pro-trial'; npm run bench` (needs `CEREBRAS_BASE_URL` set or a `.env`).
   A 404 `model_not_found` means access isn't on yet: ask in #hackathon-support.
2. Get the official OpenClaw speed patch and read how it computes TPS. Do not share it or use it in public videos.
3. Start the gateway: `powershell -ExecutionPolicy Bypass -File scripts\start-gateway.ps1` (keep the window open).
   Raw-stream logging is off by default; add `-RawStream` only to debug.
   Do one throwaway run first: the first run after a gateway start loses about 1 s warming up.
4. Sweep reasoning levels, 3 runs each, 15s apart:
   `node scripts/santa-run.mjs --gateway --thinking high --runs 3` then `medium`, `max` (`low` scored ~5x lower on the proxy).
   A run only counts as OK if it has 5 distinct links, all copied exactly from what the search tool returned
   (`logs/last-urls.json`). Failed or partial runs print ERROR or INVALID.
   If Kimi's second turn fails with a 400 after the tool call, add
   `"compat": { "requiresReasoningContentOnAssistantMessages": true }` to the Kimi model in `~/.openclaw/openclaw.json`.
   At `max`, watch for a cutoff at `maxTokens` 8192 (it shows as ERROR).
5. Rerun the best level a few times and record the best run with the patch.
   The bounty video must show the TPS and all 5 product links on screen; write the TPS in the Discord message too.
   Post in Discord #share-your-demo by Mon 23 Nov 02:00 SGT. Keep that video in Discord only: never use the patch in public X or Reddit demos.
6. If the patch measures wall time for the whole `openclaw agent` command, spawning the CLI costs 2 to 5 s per run.
   Then call the gateway from a persistent client instead.

## What we measured on the proxy model (gpt-oss-120b on Cerebras, via gateway)
| Setting | Output tokens | Agent time | Output tok/s |
|---|---|---|---|
| thinking low | ~400 | 2.1 to 6.3 s | 63 to 189 |
| thinking high | 2,000 to 3,700 | 2.6 to 3.7 s | 766 to 1,000 |

Fixed costs (Shop search ~1 s, two model round trips at ~0.4 to 0.5 s TTFT from Singapore) stay the same, so more
reasoning tokens raise tokens/sec. Tool Search off cut the run from 3 model turns to 2. The gateway removes ~22 s
of CLI startup per run. Runs that hit a 429 wait ~55 s, hence the gap between runs.

## Levers, in order of impact
1. Highest reasoning effort that doesn't push past the output cap.
2. Two model turns only: one find_gifts call with all 5 people, then the answer.
3. Gateway running (no CLI startup), stable prompt prefix so it stays cached.
4. Space runs out (15 s gap) so rate limits never trigger.
5. If the patch measures wall time from Singapore, a US-based machine would cut round-trip time. Not set up.
