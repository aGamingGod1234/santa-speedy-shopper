#!/usr/bin/env node
// Runs the Santa's Speedy Shopper task through OpenClaw (lean "santa" agent) and logs tokens/sec.
// Usage: node scripts/santa-run.mjs [--gateway] [--model cerebras/moonshotai-kimi-k3.1-pro-trial] [--thinking high]
//        [--runs 3] [--parallel 1] [--gap-ms 15000] [--prompt-file prompts/santa.txt] [--label text]
// Note: this is our own measurement from OpenClaw's usage report. The official number comes from the
// OpenClaw speed patch, which may measure differently.
import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  strict: true,
  options: {
    gateway: { type: 'boolean', default: false },
    model: { type: 'string', default: 'cerebras/moonshotai-kimi-k3.1-pro-trial' },
    // high gave ~5x the tok/s of low on the proxy model: more reasoning tokens in about the same time
    thinking: { type: 'string', default: 'high' },
    runs: { type: 'string', default: '3' },
    parallel: { type: 'string', default: '1' },
    'gap-ms': { type: 'string', default: '15000' },
    'prompt-file': { type: 'string', default: join(root, 'prompts', 'santa.txt') },
    label: { type: 'string' },
  },
});
const { model, thinking } = args;
const runs = Number(args.runs), parallel = Number(args.parallel), gapMs = Number(args['gap-ms']);
if (![runs, parallel, gapMs].every(Number.isFinite)) throw new Error('--runs, --parallel and --gap-ms must be numbers');
const OPENCLAW = process.env.OPENCLAW_ENTRY || (process.platform === 'win32'
  ? join(process.env.APPDATA, 'npm', 'node_modules', 'openclaw', 'openclaw.mjs')
  : execSync('npm root -g').toString().trim() + '/openclaw/openclaw.mjs');
const prompt = readFileSync(args['prompt-file'], 'utf8').trim();
const urlLog = join(root, 'logs', 'last-urls.json'); // written by tools/gift-search-mcp.mjs

for (const k of ['CEREBRAS_API_KEY', 'MOONSHOT_API_KEY', 'OPENCLAW_GATEWAY_TOKEN']) {
  if (!process.env[k] && process.platform === 'win32') {
    // pick up user-level env vars set after this shell started
    try {
      const v = execSync(`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('${k}','User')"`).toString().trim();
      if (v) process.env[k] = v;
    } catch {}
  }
}

// The answer must have 5 distinct links, each copied exactly from what the search tool returned.
function checkLinks(text) {
  const links = [...new Set((text.match(/https?:\/\/[^\s)>\]]+/g) || []).map(l => l.replace(/[.,;]+$/, '')))];
  let known = null;
  try { if (existsSync(urlLog)) known = new Set(JSON.parse(readFileSync(urlLog, 'utf8')).urls); } catch {}
  const unknown = known ? links.filter(l => !known.has(l)) : [];
  return { links: links.length, unknown };
}

function runOnce(i) {
  return new Promise(resolve => {
    const sid = `santa-${Date.now()}-${i}`;
    const t0 = performance.now();
    // spawn OpenClaw's entry script with node directly so the prompt is passed as one argument (no shell)
    const p = spawn(process.execPath, [OPENCLAW, 'agent', ...(args.gateway ? [] : ['--local']), '--agent', 'santa', '--model', model, '--thinking', thinking, '--session-id', sid, '-m', prompt, '--json'], { env: process.env });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => {
      const wallMs = Math.round(performance.now() - t0);
      const stderrTail = err.split('\n').filter(l => l.trim() && !/memory|current tools/.test(l)).slice(-5).join(' | ');
      let j; try { j = JSON.parse(out.slice(out.indexOf('{'))); } catch { return resolve({ i, wallMs, error: `exit ${code}: ${stderrTail}` }); }
      if (j.result) j = j.result; // gateway mode wraps the run result
      const m = j.meta || {}, a = m.agentMeta || {}, u = a.usage || {};
      const durMs = m.durationMs;
      const text = m.finalAssistantVisibleText || j.payloads?.map(p => p.text).join('\n') || '';
      // a failed run (429, length stop, tool error) can still exit 0 with partial JSON, so check it explicitly
      const failure = j.ok === false ? (j.error?.message || j.error || 'ok=false')
        : (j.status && j.status !== 'ok') ? `status ${j.status}`
        : m.error ? (m.error.message || m.error.kind || JSON.stringify(m.error))
        : !u.output || !durMs ? 'no usage or duration in result'
        : null;
      const { links, unknown } = checkLinks(text);
      resolve({
        i, model, thinking, durationMs: durMs, wallMs,
        input: u.input, cacheRead: u.cacheRead, output: u.output, reasoning: u.reasoningTokens,
        turns: a.assistantTurns, tools: a.terminalReceipt?.successfulToolNames,
        tpsOutput: u.output && durMs ? +(u.output / (durMs / 1000)).toFixed(1) : null,
        links, unknownLinks: unknown, text,
        error: failure ? `${failure}${stderrTail ? ` (${stderrTail})` : ''}` : undefined,
        valid: !failure && links >= 5 && unknown.length === 0,
      });
    });
  });
}

// pause between batches so per-minute rate limits never trigger OpenClaw's ~55s retry backoff
const results = [];
for (let r = 0; r < runs; r += parallel) {
  if (r > 0 && gapMs) await new Promise(res => setTimeout(res, gapMs));
  const batch = await Promise.all(Array.from({ length: Math.min(parallel, runs - r) }, (_, k) => runOnce(r + k)));
  for (const x of batch) {
    results.push(x);
    if (x.error) { console.log(`run ${x.i + 1}: ERROR ${x.error}`); continue; }
    const check = x.valid ? 'OK' : `INVALID (${x.links} links${x.unknownLinks.length ? `, ${x.unknownLinks.length} not from the search tool` : ''})`;
    console.log(`run ${x.i + 1}: ${x.durationMs}ms agent (${x.wallMs}ms wall) | out ${x.output} (reasoning ${x.reasoning}) | in ${x.input} + cached ${x.cacheRead} | turns ${x.turns} | tools ${x.tools?.join(',') || '-'} | ${x.tpsOutput} tok/s | ${check}`);
  }
}
const ok = results.filter(x => x.valid).sort((a, b) => b.tpsOutput - a.tpsOutput);
if (ok[0]) {
  const tps = ok.map(x => x.tpsOutput).sort((a, b) => a - b);
  console.log(`valid runs: ${ok.length}/${results.length} | median ${tps[Math.floor(tps.length / 2)]} tok/s | best ${ok[0].tpsOutput} tok/s (run ${ok[0].i + 1})\n--- best run answer ---\n${ok[0].text}`);
} else console.log(`no valid runs out of ${results.length}`);
mkdirSync(join(root, 'logs'), { recursive: true });
const f = join(root, 'logs', `santa-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(f, JSON.stringify({ model, thinking, label: args.label || null, results }, null, 2));
console.log(`wrote ${f}`);
