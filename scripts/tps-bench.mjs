#!/usr/bin/env node
// Streams chat completions against an OpenAI-compatible endpoint and reports timing and tokens/sec.
// No dependencies. Reads config from env (load .env with `node --env-file=.env` or `npm run bench`).
//
//   node scripts/tps-bench.mjs --provider cerebras --runs 3 --reasoning-effort low --prompt-file prompt.txt
//
// --provider cerebras uses CEREBRAS_BASE_URL / CEREBRAS_API_KEY / CEREBRAS_MODEL
// --provider gpu      uses GPU_PROVIDER_BASE_URL / GPU_PROVIDER_API_KEY / GPU_PROVIDER_MODEL
//
// Metrics per run:
//   ttft_ms         request start to first streamed token (reasoning or answer)
//   total_ms        request start to end of stream
//   output_tps      completion_tokens / (last token time - first token time)
//   e2e_tps         completion_tokens / total time
//   server_tps      completion_tokens / time_info.completion_time, when the server sends time_info (Cerebras)

import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `Usage: node scripts/tps-bench.mjs [options]

  --provider <cerebras|gpu>     which env var set to use (default cerebras)
  --runs <n>                    number of sequential runs (default 3)
  --reasoning-effort <level>    low | medium | high | max | none (omitted if not set)
  --prompt-file <path>          .txt (sent as one user message) or .json (array of messages)
  --max-tokens <n>              max_completion_tokens (default 4096)
  --no-include-usage            do not send stream_options.include_usage
  --label <text>                free-text label stored in the log
  -h, --help                    show this help
`;

const DEFAULT_PROMPT =
  'Suggest 5 Christmas gifts: my mom who gardens, my dad who grills, my sister who climbs, ' +
  'my brother who games, and my best friend who loves coffee. One line each with a short reason.';

const ENV_SETS = {
  cerebras: { base: 'CEREBRAS_BASE_URL', key: 'CEREBRAS_API_KEY', model: 'CEREBRAS_MODEL' },
  gpu: { base: 'GPU_PROVIDER_BASE_URL', key: 'GPU_PROVIDER_API_KEY', model: 'GPU_PROVIDER_MODEL' },
};
const EFFORTS = ['low', 'medium', 'high', 'max', 'none'];

class RateLimitError extends Error {}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        provider: { type: 'string', default: 'cerebras' },
        runs: { type: 'string', default: '3' },
        'reasoning-effort': { type: 'string' },
        'prompt-file': { type: 'string' },
        'max-tokens': { type: 'string', default: '4096' },
        'include-usage': { type: 'boolean', default: true },
        'no-include-usage': { type: 'boolean', default: false },
        label: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    });
  } catch (err) {
    fail(`${err.message}\n\n${HELP}`);
  }
  const v = parsed.values;
  if (v.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (!ENV_SETS[v.provider]) fail(`--provider must be cerebras or gpu, got "${v.provider}"`);
  const runs = Number.parseInt(v.runs, 10);
  if (!Number.isInteger(runs) || runs < 1) fail('--runs must be a positive integer');
  const maxTokens = Number.parseInt(v['max-tokens'], 10);
  if (!Number.isInteger(maxTokens) || maxTokens < 1) fail('--max-tokens must be a positive integer');
  const effort = v['reasoning-effort'];
  if (effort !== undefined && !EFFORTS.includes(effort)) fail(`--reasoning-effort must be one of ${EFFORTS.join(', ')}`);
  return {
    provider: v.provider,
    runs,
    effort,
    promptFile: v['prompt-file'],
    maxTokens,
    includeUsage: v['include-usage'] && !v['no-include-usage'],
    label: v.label ?? null,
  };
}

async function loadMessages(promptFile) {
  if (!promptFile) return [{ role: 'user', content: DEFAULT_PROMPT }];
  const text = await readFile(promptFile, 'utf8').catch((err) => fail(`cannot read --prompt-file: ${err.message}`));
  if (promptFile.toLowerCase().endsWith('.json')) {
    let msgs;
    try {
      msgs = JSON.parse(text);
    } catch (err) {
      fail(`--prompt-file is not valid JSON: ${err.message}`);
    }
    if (!Array.isArray(msgs) || !msgs.every((m) => m && typeof m.role === 'string')) {
      fail('--prompt-file .json must be an array of {role, content} messages');
    }
    return msgs;
  }
  return [{ role: 'user', content: text }];
}

// Reads an SSE body and yields each parsed `data:` JSON payload with its arrival time.
async function* readSse(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const rawEvent = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      const data = rawEvent
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      if (data === '[DONE]') return;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue; // ignore keep-alives or malformed lines
      }
      yield { json, at: performance.now() };
    }
  }
}

function rateLimitHeaders(headers) {
  const out = {};
  for (const [k, v] of headers) if (k.startsWith('x-ratelimit') || k === 'retry-after') out[k] = v;
  return out;
}

async function runOnce({ baseUrl, apiKey, model, messages, effort, maxTokens, includeUsage }) {
  const body = { model, messages, stream: true, max_completion_tokens: maxTokens };
  if (effort) body.reasoning_effort = effort;
  if (includeUsage) body.stream_options = { include_usage: true };

  const t0 = performance.now();
  let res;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`network error: ${err.cause?.message || err.message}`);
  }

  if (res.status === 429) {
    const text = await res.text().catch(() => '');
    const hdrs = rateLimitHeaders(res.headers);
    throw new RateLimitError(
      'HTTP 429 rate limited. Cerebras counts prompt + max_completion_tokens against TPM before running, ' +
        'so try a lower --max-tokens, fewer runs, or wait for the bucket to refill.\n' +
        `  headers: ${JSON.stringify(hdrs)}\n  body: ${text.slice(0, 500)}`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const hint = res.status === 400 && includeUsage ? ' (if the server rejects stream_options, retry with --no-include-usage)' : '';
    throw new Error(`HTTP ${res.status}${hint}: ${text.slice(0, 500)}`);
  }
  const headersAt = performance.now();

  let firstTokenAt = null;
  let firstAnswerAt = null;
  let lastTokenAt = null;
  let usage = null;
  let timeInfo = null;
  let contentChars = 0;
  let reasoningChars = 0;
  let chunks = 0;
  let finishReason = null;
  let content = '';

  for await (const { json, at } of readSse(res.body)) {
    chunks++;
    if (json.error) throw new Error(`stream error: ${JSON.stringify(json.error).slice(0, 500)}`);
    if (json.usage) usage = json.usage;
    if (json.time_info) timeInfo = json.time_info;
    const choice = json.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const d = choice.delta || {};
    const reasoning = d.reasoning ?? d.reasoning_content ?? '';
    const text = d.content ?? '';
    const toolArgs = (d.tool_calls || []).map((t) => t.function?.arguments || '').join('');
    if (reasoning || text || toolArgs) {
      firstTokenAt ??= at;
      lastTokenAt = at;
    }
    if (text && firstAnswerAt === null) firstAnswerAt = at;
    reasoningChars += reasoning.length;
    contentChars += text.length + toolArgs.length;
    content += text;
  }
  const t1 = performance.now();

  const completion = usage?.completion_tokens ?? null;
  const genSec = firstTokenAt !== null && lastTokenAt > firstTokenAt ? (lastTokenAt - firstTokenAt) / 1000 : null;
  const totalSec = (t1 - t0) / 1000;
  const round = (n, p = 1) => (n === null || n === undefined || !Number.isFinite(n) ? null : Number(n.toFixed(p)));

  return {
    ok: true,
    http_headers_ms: round(headersAt - t0),
    ttft_ms: firstTokenAt === null ? null : round(firstTokenAt - t0),
    first_answer_token_ms: firstAnswerAt === null ? null : round(firstAnswerAt - t0),
    generation_ms: genSec === null ? null : round(genSec * 1000),
    total_ms: round(t1 - t0),
    prompt_tokens: usage?.prompt_tokens ?? null,
    completion_tokens: completion,
    reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    cached_tokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
    output_tps: completion !== null && genSec ? round(completion / genSec) : null,
    e2e_tps: completion !== null ? round(completion / totalSec) : null,
    server_tps: completion !== null && timeInfo?.completion_time ? round(completion / timeInfo.completion_time) : null,
    time_info: timeInfo,
    finish_reason: finishReason,
    stream_chunks: chunks,
    reasoning_chars: reasoningChars,
    content_chars: contentChars,
    usage_missing: usage === null,
    content_preview: content.slice(0, 200),
  };
}

function median(nums) {
  const xs = nums.filter((n) => typeof n === 'number').sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : Number(((xs[m - 1] + xs[m]) / 2).toFixed(1));
}

// Timestamp in Singapore time (UTC+8), safe for filenames: 20261122-021530-SGT
function sgtStamp(d = new Date()) {
  const s = new Date(d.getTime() + 8 * 3600 * 1000).toISOString();
  return `${s.slice(0, 10).replaceAll('-', '')}-${s.slice(11, 19).replaceAll(':', '')}-SGT`;
}

const fmt = (v, unit = '') => (v === null || v === undefined ? '-' : `${v}${unit}`);

async function main() {
  const opts = parseCli();
  const env = ENV_SETS[opts.provider];
  const baseUrl = process.env[env.base];
  const apiKey = process.env[env.key];
  const model = process.env[env.model];
  const missing = [
    [env.base, baseUrl],
    [env.key, apiKey],
    [env.model, model],
  ].filter(([, val]) => !val).map(([name]) => name);
  if (missing.length) fail(`missing env vars: ${missing.join(', ')} (copy .env.example to .env)`);
  if (opts.provider === 'cerebras' && opts.effort === 'none') {
    console.warn('warning: Cerebras Kimi K3.1 Pro rejects reasoning_effort "none" (always reasons).');
  }

  const messages = await loadMessages(opts.promptFile);
  const startedAt = new Date();
  console.log(
    `provider=${opts.provider} model=${model} base=${baseUrl} runs=${opts.runs} ` +
      `effort=${opts.effort ?? '(server default)'} max_tokens=${opts.maxTokens}`,
  );

  const results = [];
  let stoppedBy429 = false;
  for (let i = 1; i <= opts.runs; i++) {
    try {
      const r = await runOnce({ baseUrl, apiKey, model, messages, ...opts });
      results.push({ run: i, ...r });
      console.log(
        `run ${i}: ttft ${fmt(r.ttft_ms, 'ms')} | total ${fmt(r.total_ms, 'ms')} | ` +
          `prompt ${fmt(r.prompt_tokens)} (cached ${fmt(r.cached_tokens)}) | completion ${fmt(r.completion_tokens)} ` +
          `(reasoning ${fmt(r.reasoning_tokens)}) | output ${fmt(r.output_tps, ' tok/s')} | ` +
          `e2e ${fmt(r.e2e_tps, ' tok/s')} | server ${fmt(r.server_tps, ' tok/s')}`,
      );
      if (r.usage_missing) console.warn(`  warning: no usage block in stream; token counts and tok/s are unavailable.`);
    } catch (err) {
      const rateLimited = err instanceof RateLimitError;
      results.push({ run: i, ok: false, rate_limited: rateLimited, error: err.message });
      console.error(`run ${i}: ${err.message}`);
      if (rateLimited) {
        stoppedBy429 = true;
        console.error('stopping remaining runs after 429.');
        break;
      }
    }
  }

  const ok = results.filter((r) => r.ok);
  const summary = {
    runs_ok: ok.length,
    runs_failed: results.length - ok.length,
    median_ttft_ms: median(ok.map((r) => r.ttft_ms)),
    median_total_ms: median(ok.map((r) => r.total_ms)),
    median_output_tps: median(ok.map((r) => r.output_tps)),
    median_e2e_tps: median(ok.map((r) => r.e2e_tps)),
    median_server_tps: median(ok.map((r) => r.server_tps)),
  };
  console.log(
    `median: ttft ${fmt(summary.median_ttft_ms, 'ms')} | total ${fmt(summary.median_total_ms, 'ms')} | ` +
      `output ${fmt(summary.median_output_tps, ' tok/s')} | e2e ${fmt(summary.median_e2e_tps, ' tok/s')} | ` +
      `server ${fmt(summary.median_server_tps, ' tok/s')}`,
  );

  const logsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'logs');
  await mkdir(logsDir, { recursive: true });
  const log = {
    started_at_sgt: sgtStamp(startedAt),
    label: opts.label,
    provider: opts.provider,
    base_url: baseUrl,
    model,
    reasoning_effort: opts.effort ?? null,
    max_completion_tokens: opts.maxTokens,
    include_usage: opts.includeUsage,
    prompt_file: opts.promptFile ?? null,
    stopped_by_429: stoppedBy429,
    summary,
    runs: results,
  };
  // Parallel benches can start in the same second; add a suffix instead of overwriting.
  let file;
  for (let n = 1; ; n++) {
    file = resolve(logsDir, `bench-${sgtStamp(startedAt)}${n > 1 ? `-${n}` : ''}.json`);
    try {
      await writeFile(file, JSON.stringify(log, null, 2), { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  console.log(`wrote ${file}`);
  if (!ok.length) process.exit(stoppedBy429 ? 2 : 1);
}

main().catch((err) => fail(err.stack || err.message));
