#!/usr/bin/env node
// Runs the Santa's Speedy Shopper task through OpenClaw (lean "santa" agent) and logs tokens/sec.
// Usage: node scripts/santa-run.mjs [--model cerebras/moonshotai-kimi-k3.1-pro-trial] [--thinking low] [--runs 3]
//        [--parallel 1] [--prompt-file prompts/santa.txt] [--label text]
// Note: this is our own measurement from OpenClaw's usage report. The official number comes from the
// OpenClaw speed patch, which may measure differently.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]] : a), []));
const model = args.model || 'cerebras/moonshotai-kimi-k3.1-pro-trial';
const thinking = args.thinking || 'low';
const runs = Number(args.runs || 3);
const parallel = Number(args.parallel || 1);
const OPENCLAW = process.env.OPENCLAW_ENTRY || (process.platform === 'win32'
  ? join(process.env.APPDATA, 'npm', 'node_modules', 'openclaw', 'openclaw.mjs')
  : (await import('node:child_process')).execSync('npm root -g').toString().trim() + '/openclaw/openclaw.mjs');
const prompt = readFileSync(args['prompt-file'] || join(root, 'prompts', 'santa.txt'), 'utf8').trim();

for (const k of ['CEREBRAS_API_KEY', 'MOONSHOT_API_KEY', 'OPENCLAW_GATEWAY_TOKEN']) {
  if (!process.env[k] && process.platform === 'win32') {
    // pick up user-level env vars set after this shell started
    try {
      const { execSync } = await import('node:child_process');
      const v = execSync(`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('${k}','User')"`).toString().trim();
      if (v) process.env[k] = v;
    } catch {}
  }
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
      const wallMs = performance.now() - t0;
      let j; try { j = JSON.parse(out.slice(out.indexOf('{'))); } catch { return resolve({ i, error: `exit ${code}: ${err.split('\n').filter(l => !/memory|current tools/.test(l)).slice(-5).join(' | ')}` }); }
      if (j.result) j = j.result; // gateway mode wraps the run result
      const m = j.meta || {}, a = m.agentMeta || {}, u = a.usage || {};
      const durMs = m.durationMs;
      const text = m.finalAssistantVisibleText || j.payloads?.map(p => p.text).join('\n') || '';
      const links = (text.match(/https?:\/\/[^\s)>\]]+/g) || []);
      resolve({
        i, model, thinking, durationMs: durMs, wallMs: Math.round(wallMs),
        input: u.input, cacheRead: u.cacheRead, output: u.output, reasoning: u.reasoningTokens,
        turns: a.assistantTurns, tools: a.terminalReceipt?.successfulToolNames,
        tpsOutput: u.output && durMs ? +(u.output / (durMs / 1000)).toFixed(1) : null,
        links: links.length, text,
      });
    });
  });
}

// pause between batches so per-minute rate limits never trigger OpenClaw's ~55s retry backoff
const gapMs = Number(args['gap-ms'] ?? 15000);
const results = [];
for (let r = 0; r < runs; r += parallel) {
  if (r > 0 && gapMs) await new Promise(res => setTimeout(res, gapMs));
  const batch = await Promise.all(Array.from({ length: Math.min(parallel, runs - r) }, (_, k) => runOnce(r + k)));
  for (const x of batch) {
    results.push(x);
    if (x.error) console.log(`run ${x.i + 1}: ERROR ${x.error}`);
    else console.log(`run ${x.i + 1}: ${x.durationMs}ms agent (${x.wallMs}ms wall) | out ${x.output} (reasoning ${x.reasoning}) | in ${x.input} + cached ${x.cacheRead} | turns ${x.turns} | tools ${x.tools?.join(',') || '-'} | ${x.tpsOutput} tok/s | links ${x.links}`);
  }
}
const ok = results.filter(x => !x.error).sort((a, b) => b.tpsOutput - a.tpsOutput);
if (ok[0]) console.log(`best: ${ok[0].tpsOutput} tok/s (run ${ok[0].i + 1})\n--- best run answer ---\n${ok[0].text}`);
mkdirSync(join(root, 'logs'), { recursive: true });
const f = join(root, 'logs', `santa-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(f, JSON.stringify({ model, thinking, label: args.label || null, results }, null, 2));
console.log(`wrote ${f}`);
