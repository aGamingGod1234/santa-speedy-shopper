# Santa's Speedy Shopper

Say your family's gift list out loud and get 5 real Christmas gifts from real online stores, with prices and links, in a few seconds. Built for the Kimi K3.1 Pro x Cerebras x OpenClaw hackathon (Nov 2026).

## Team

TODO: X / Reddit handles

## What it does

You talk ("my mom loves coffee, my dad is into music, my sister climbs..."). An OpenClaw agent running Kimi K3.1 Pro searches real shopping catalogs for every person at once and picks one gift each. Each gift lands as a card with its photo, price and store; click it to open the real product page.

A switch runs the same list on the same model through the Moonshot API or on Cerebras, so you can see the difference in speed on the exact same task.

## How it works

```
browser (voice via Web Speech API)
  -> server.mjs  POST /api/run
  -> OpenClaw gateway, OpenAI-compatible /v1/chat/completions, agent "santa"
       model: cerebras/moonshotai-kimi-k3.1-pro-trial  or  moonshot/kimi-k3.1-pro
  -> tool gifts__find_gifts (tools/gift-search-mcp.mjs, a stdio MCP server)
       searches the Shop catalog (mcp.shop.com) for every person in parallel
  <- the agent answers one line per person: person: product, price, store, URL
  <- server.mjs streams each parsed line to the page as it arrives
```

- The `santa` agent is lean: no workspace files, no skills, no memory plugin, one tool, Tool Search off. Two model turns per run: one tool call, one answer.
- Every product, price and link comes from that run's live search. The tool also records what it returned (`logs/last-urls.json`), and the speed scripts reject any answer whose links were not in the search results.
- Same prompt, same model, same machine on both sides. Only the provider changes.

## Speed results

Times are for the whole app request (voice list sent to all 5 gifts shown), measured in the app. The OpenClaw speed patch numbers are the server-side decode rate Cerebras reports for each model call, averaged over the session.

| What | Result |
|---|---|
| App, Cerebras | TODO: median of timed runs |
| App, Moonshot API | TODO: median of timed runs |
| Speed Bounty (patched OpenClaw, Kimi K3.1 Pro on Cerebras, reasoning low) | best 1,239 tok/s mean (1,373 p90) |

How the Speed Bounty run is tuned is in [SPEEDRUN.md](SPEEDRUN.md). The short version: Kimi on Cerebras decodes text it copies from its context about 3 times faster than text it writes from scratch, so the bounty prompt has the model copy the search terms into the tool call and copy each product's fields from the search results.

## Run it

Needs Node 24, [OpenClaw](https://github.com/openclaw/openclaw) installed (`npm i -g openclaw`), a Cerebras API key with Kimi K3.1 Pro access, and optionally a Moonshot API key for the comparison.

1. Set `CEREBRAS_API_KEY`, `MOONSHOT_API_KEY` and `OPENCLAW_GATEWAY_TOKEN` (any long random string) as environment variables.
2. `openclaw plugins install npm:@openclaw/cerebras-provider`, then merge `config/openclaw.cerebras.json5` into `~/.openclaw/openclaw.json` (replace `<REPO>` with this folder's path). It defines the `santa` agent, both providers, the `gifts` MCP server, and turns on the gateway's chat completions endpoint (`gateway.http.endpoints.chatCompletions.enabled`).
3. Start the gateway: `powershell -ExecutionPolicy Bypass -File scripts\start-gateway.ps1` (or `openclaw gateway`).
4. `npm start`, then open http://127.0.0.1:3000 in Chrome (voice input needs Chrome or Edge).
5. Press Space and say your list; press Space again to send. S switches provider, Enter sends the same list again, E shows the end card, R resets. `?record=1` shows the 1080x960 frame at exact size for screen recording; `?countdown=1` adds the "Christmas in 2:00" clock.

## What existed before kickoff

The hackathon allows pre-existing scaffolding. These were committed before kickoff (Sun 22 Nov 02:00 SGT):

- Project scaffold: static server, package.json, license, this README skeleton.
- A UI mockup with invented sample data, used to plan the video layout (now `public/mock.html`). It is not connected to anything.
- Speed-run tooling: a small MCP gift-search tool over the Shop catalog, a runner script that times OpenClaw runs, a gateway start script, and OpenClaw config. Tested only on `gpt-oss-120b`, because Kimi K3.1 Pro access was not on yet.

Everything else (the Kimi K3.1 Pro on Cerebras agent, the app wired to real results, voice input, the provider comparison, the Speed Bounty tuning) was built during the event. The git history shows which is which.

## License

MIT
