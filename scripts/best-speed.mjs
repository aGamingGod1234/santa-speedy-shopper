#!/usr/bin/env node
// Lists the best valid Speed Bounty runs across all logs/speed-*.json batches (from scripts/speed-score.mjs).
// Usage: node scripts/best-speed.mjs [--top 10] [--since 2026-11-22T07:00+08:00]
// --since keeps only runs started after that time (session keys hold the start time in ms), e.g. runs made
// after the Kimi model entry was switched to the official patch config at 07:00 SGT.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ strict: true, options: { top: { type: 'string', default: '10' }, since: { type: 'string' } } });
const since = args.since ? Date.parse(args.since) : 0;
const logs = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');
const runs = [];
for (const f of readdirSync(logs).filter(f => /^speed-.*\.json$/.test(f))) {
  const j = JSON.parse(readFileSync(join(logs, f), 'utf8'));
  for (const r of j.results) {
    const started = parseInt(r.sessionKey?.split('bench-')[1], 10) || 0;
    if (r.valid && started >= since) runs.push({ ...r, label: j.label, thinking: j.thinking, file: f });
  }
}
runs.sort((a, b) => b.mean - a.mean);
const all = runs.map(r => r.mean).sort((a, b) => a - b);
console.log(`${runs.length} valid runs | median ${all[Math.floor(all.length / 2)] ?? '-'} | best ${all.at(-1) ?? '-'}`);
for (const r of runs.slice(0, Number(args.top))) {
  console.log(`${String(r.mean).padStart(7)} tok/s | calls ${r.rates.join(', ')} | ${r.label} | ${r.sessionKey}`);
}
if (runs[0]) console.log(`\nbest session to open in the web chat: ${runs[0].sessionKey}\n${runs[0].text}`);
