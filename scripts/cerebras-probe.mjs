#!/usr/bin/env node
// Logs how busy Kimi on Cerebras is, through OpenClaw (organizers asked to use the key only within OpenClaw),
// every 10 min until --until, so we can pick a quiet time to film. Each probe runs the real app request
// (the santa agent finding 5 gifts) via the standard gateway and logs the time until the answer is complete.
// Usage: node scripts/cerebras-probe.mjs [--until "2026-11-22T20:00:00+08:00"] [--every-min 10]
import { execSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
const { values: a } = parseArgs({ strict: true, options: { until: { type: 'string', default: '2026-11-22T20:00:00+08:00' }, 'every-min': { type: 'string', default: '10' } } });
const token = process.env.OPENCLAW_GATEWAY_TOKEN || execSync(`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('OPENCLAW_GATEWAY_TOKEN','User')"`).toString().trim();
const log = new URL('../logs/cerebras-probe.log', import.meta.url);
const sgt = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
const LIST = 'my mom loves coffee, my dad is into music, my sister climbs, my brother games, and grandma reads mystery novels';
async function probe() {
  const t0 = performance.now();
  try {
    const r = await fetch('http://127.0.0.1:18789/v1/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(300000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-openclaw-model': 'cerebras/moonshotai-kimi-k3.1-pro-trial' },
      body: JSON.stringify({ model: 'openclaw/santa', messages: [{ role: 'user', content: `Find Christmas gifts from real shopping websites for this list: "${LIST}"\nCall the gifts__find_gifts tool once with every person on the list. Then reply with one line per person: person: product title, price, store, product URL. Copy fields exactly. No other text.` }] }),
    });
    const j = await r.json();
    const text = j.choices?.[0]?.message?.content || '';
    const links = (text.match(/https?:\/\//g) || []).length;
    return `${r.ok ? 'ok' : 'HTTP ' + r.status} | app run ${((performance.now() - t0) / 1000).toFixed(1)}s | ${links} links${r.ok ? '' : ' | ' + JSON.stringify(j).slice(0, 100)}`;
  } catch (e) { return `error after ${((performance.now() - t0) / 1000).toFixed(0)}s: ${e.message}`; }
}
while (Date.now() < Date.parse(a.until)) {
  appendFileSync(log, `${sgt()} SGT ${await probe()}\n`);
  await new Promise(r => setTimeout(r, Number(a['every-min']) * 60e3));
}
