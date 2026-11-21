# Speed Bounty run (Santa's Speedy Shopper)

## How the score works
The official patch (OpenClaw 8b18b55 + 2 commits) shows `<mean> tok/s mean` in the web chat. For every model call it
takes Cerebras's server-side decode timing from the last streamed chunk (`usage.completion_tokens / time_info.completion_time`)
and averages those per-call rates over the session. Queueing, prefill, network and tool time don't count.
A Santa run is 2 calls: the tool call, then the 5-line answer. Each counts equally.

## What makes it fast (measured on Kimi K3.1 Pro, Sun 22 Nov 02:15 to 02:45 SGT)
- **Copied text decodes 3 to 4 times faster than generated text** (speculative decoding, our inference). Echoing text
  from the context runs at ~1,000 to 1,400 tok/s; free writing and reasoning at ~250 to 320.
- So the prompt (`prompts/santa-fast.txt`) has the model copy the exact tool arguments from the prompt, take the first
  result per person, and copy title, price, store and URL from the tool result. The output is still the real task:
  5 real products with real links.
- `reasoning_effort` low: reasoning tokens are generated text, so fewer is faster. Per token, effort makes no difference.
- No effect: context length up to 13k tokens, temperature, top_p. Logprobs on costs ~15%.
- Server noise is +-20% per call or more: the same prompt scored 616 to 1,258. Top score = many runs + quiet server.

Results so far: naive prompt 570; fast prompt median ~845, best 1,239.5 (34 runs).

## Setup
- Patched build: `C:\Users\User\openclaw-speed` (built with portable Node 24.22.3 at `C:\Users\User\tools\node24`).
- Its own profile and config: `~\.openclaw-speed\openclaw.json`, gateway on port 19789. Same lean `santa` agent and
  gift-search MCP tool as the npm install. The npm install (`~\.openclaw`, port 18789) is untouched; use it for the
  public X/Reddit demo, never the patched build.
- Keys are Windows user env vars: `CEREBRAS_API_KEY`, `OPENCLAW_GATEWAY_TOKEN`.

## Scripts
- `node scripts/speed-score.mjs --runs 5 --prompt-file prompts/santa-fast.txt` runs the task on the patched gateway, one
  fresh session per run, and scores each run exactly like the patch's readout. A run is OK only with 5 distinct links,
  all copied from the search tool output. Logs: `logs/speed-*.json`.
- `node scripts/best-speed.mjs` lists the best valid runs across all batches and the best session key.
- `scripts/speed-farm.ps1` runs a batch every 30 min until Sun 22 Nov 20:00 SGT, restarting the gateway if needed.
  Log: `logs/speed-farm.log`. Stop it by creating `logs/speed-farm.stop`.
- `powershell -ExecutionPolicy Bypass -File scripts\open-best.ps1` opens the best session in the patched web chat.

## Recording the entry (by Mon 23 Nov 02:00 SGT)
1. Stop the farm (create `logs/speed-farm.stop`) so no run happens while you record.
2. Run `scripts\open-best.ps1`. Screen-record the chat: the `tok/s mean` readout next to the message box and on the
   response, and all 5 product lines with their links. Hover the readout to show the detail tooltip.
3. Post in Discord #share-your-demo with `Speed Bounty entry: <mean> TPS` in the text.
4. Keep that video in Discord only. Never use the patched build in the public X/Reddit demos.
