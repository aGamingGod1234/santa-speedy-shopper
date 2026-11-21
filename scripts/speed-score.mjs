#!/usr/bin/env node
// Runs the Santa task on the PATCHED OpenClaw build (profile "speed") and computes the official Speed Bounty score
// the way the patch's chat UI does: mean over the session's model calls of outputTokens / completionMs (server timing).
// Usage: node scripts/speed-score.mjs [--thinking low] [--runs 3] [--gap-ms 5000] [--model cerebras/moonshotai-kimi-k3.1-pro-trial]
//        [--prompt-file prompts/santa.txt] [--label text]
// Needs: the patched build at OPENCLAW_SPEED_DIR (default C:\Users\User\openclaw-speed), its gateway running
// (`openclaw --profile speed gateway run`), and Node >= 24.22 at NODE_SPEED (default C:\Users\User\tools\node24\node.exe).
import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  strict: true,
  options: {
    thinking: { type: 'string', default: 'low' },
    model: { type: 'string', default: 'cerebras/moonshotai-kimi-k3.1-pro-trial' },
    runs: { type: 'string', default: '3' },
    'gap-ms': { type: 'string', default: '5000' },
    'prompt-file': { type: 'string', default: join(root, 'prompts', 'santa.txt') },
    label: { type: 'string' },
  },
});
const OC = join(process.env.OPENCLAW_SPEED_DIR || 'C:/Users/User/openclaw-speed', 'openclaw.mjs');
const NODE = process.env.NODE_SPEED || 'C:/Users/User/tools/node24/node.exe';
const prompt = readFileSync(args['prompt-file'], 'utf8').trim();
const urlLog = join(root, 'logs', 'last-urls.json');

for (const k of ['CEREBRAS_API_KEY', 'OPENCLAW_GATEWAY_TOKEN']) {
  if (!process.env[k] && process.platform === 'win32') {
    try {
      const v = execSync(`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('${k}','User')"`).toString().trim();
      if (v) process.env[k] = v;
    } catch {}
  }
}

function oc(argv) {
  return new Promise(resolve => {
    const p = spawn(NODE, [OC, '--profile', 'speed', ...argv], { env: process.env });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => resolve({ code, out, err }));
  });
}
const parseJson = s => { try { return JSON.parse(s.slice(s.indexOf('{'))); } catch { return null; } };

// same rule as the patch's chat-generation-speed.ts: only calls with completionMs > 0 and outputTokens >= 1 count
function score(messages) {
  const calls = messages
    .filter(m => m?.role === 'assistant' && m.serverGeneration)
    .map(m => ({ out: m.serverGeneration.outputTokens, ms: m.serverGeneration.completionMs }))
    .filter(c => Number.isFinite(c.ms) && c.ms > 0 && Number.isFinite(c.out) && c.out >= 1);
  const rates = calls.map(c => c.out / (c.ms / 1000));
  return { calls, rates, mean: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null };
}

function checkLinks(text) {
  const links = [...new Set((text.match(/https?:\/\/[^\s)>\]]+/g) || []).map(l => l.replace(/[.,;]+$/, '')))];
  let known = null;
  try { if (existsSync(urlLog)) known = new Set(JSON.parse(readFileSync(urlLog, 'utf8')).urls); } catch {}
  return { links: links.length, unknown: known ? links.filter(l => !known.has(l)) : [] };
}

const results = [];
for (let i = 0; i < Number(args.runs); i++) {
  if (i > 0) await new Promise(r => setTimeout(r, Number(args['gap-ms'])));
  const sessionKey = `agent:santa:bench-${Date.now()}`;
  const t0 = performance.now();
  const run = await oc(['agent', '--session-key', sessionKey, '--model', args.model, '--thinking', args.thinking, '-m', prompt, '--json']);
  const wallMs = Math.round(performance.now() - t0);
  const hist = await oc(['gateway', 'call', 'chat.history', '--params', JSON.stringify({ sessionKey, limit: 500 }), '--json']);
  const h = parseJson(hist.out);
  const messages = h?.messages || h?.result?.messages || [];
  const s = score(messages);
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  const text = typeof lastAssistant?.content === 'string' ? lastAssistant.content
    : (lastAssistant?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  const { links, unknown } = checkLinks(text);
  const valid = s.mean !== null && links >= 5 && unknown.length === 0;
  const r = { i, sessionKey, thinking: args.thinking, wallMs, mean: s.mean && +s.mean.toFixed(1), rates: s.rates.map(x => +x.toFixed(1)), calls: s.calls, links, unknownLinks: unknown, valid, text,
    error: s.mean === null ? `no server timing (run exit ${run.code}: ${(run.err || hist.err).split('\n').filter(l => l.trim() && !/startup phase/.test(l)).slice(-3).join(' | ')})` : undefined };
  results.push(r);
  if (r.error) console.log(`run ${i + 1}: ERROR ${r.error}`);
  else console.log(`run ${i + 1}: SCORE ${r.mean} tok/s mean | per call ${r.rates.join(', ')} | tokens ${s.calls.map(c => c.out).join('+')} | ${wallMs}ms wall | ${valid ? 'OK' : `INVALID (${links} links, ${unknown.length} not from search)`}`);
}
const ok = results.filter(r => r.valid).sort((a, b) => b.mean - a.mean);
if (ok.length) {
  const m = ok.map(r => r.mean).sort((a, b) => a - b);
  console.log(`valid ${ok.length}/${results.length} | median ${m[Math.floor(m.length / 2)]} | best ${ok[0].mean} (${ok[0].sessionKey})\n--- best answer ---\n${ok[0].text}`);
}
mkdirSync(join(root, 'logs'), { recursive: true });
const f = join(root, 'logs', `speed-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(f, JSON.stringify({ thinking: args.thinking, model: args.model, label: args.label || null, results }, null, 2));
console.log(`wrote ${f}`);
