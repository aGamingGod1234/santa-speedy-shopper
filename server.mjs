// Dev server: static files from public/ plus /api/run, which runs the gift task through OpenClaw. No dependencies.
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(ROOT, rel));
  // Block path traversal outside public/.
  if (file !== ROOT && !file.startsWith(ROOT + sep)) return sendJson(res, 403, { error: 'forbidden' });
  try {
    const info = await stat(file);
    if (info.isDirectory()) return serveStatic(req, res, pathname.replace(/\/?$/, '/'));
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

// ---------- Gift run: the browser's spoken list -> OpenClaw santa agent -> streamed gift lines ----------
// Uses the standard OpenClaw gateway (npm install, not the speed-patched build) through its
// OpenAI-compatible endpoint, so the agent runs exactly as `openclaw agent` would and the answer streams.
const GATEWAY = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const PROVIDERS = {
  cerebras: { model: 'cerebras/moonshotai-kimi-k3.1-pro-trial', label: 'Cerebras' },
  moonshot: { model: 'moonshot/kimi-k3.1-pro', label: 'Moonshot API' },
};
const RESULTS_FILE = resolve(fileURLToPath(new URL('.', import.meta.url)), 'logs', 'last-results.json');

function gatewayToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  if (process.platform !== 'win32') return '';
  try {
    return execSync(`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('OPENCLAW_GATEWAY_TOKEN','User')"`).toString().trim();
  } catch { return ''; }
}

const giftPrompt = list => `Find Christmas gifts from real shopping websites for this list: "${list}"
Call the gifts__find_gifts tool once with every person on the list. Then reply with one line per person, in the order they were mentioned, exactly in this format:
person: product title, price, store, product URL
Copy the title, price, store and URL exactly from the tool result. No other text.`;

// "mom: Bolt Chalk Bag, 25.00 USD, madrock.com, https://..." (titles can contain commas, so parse from the right)
const LINE = /^\W*([^:]{1,40}):\s*(.+),\s*([^,]*\d[^,]*),\s*([^,\s]+),\s*(https?:\/\/\S+?)[.,;]?\s*$/;
async function imageFor(url) {
  try {
    const { products } = JSON.parse(await readFile(RESULTS_FILE, 'utf8'));
    return products.find(p => p.url === url)?.image || null;
  } catch { return null; }
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 1e5) throw new Error('body too large'); }
  return JSON.parse(body || '{}');
}

async function runGifts(req, res) {
  let input;
  try { input = await readBody(req); } catch { return sendJson(res, 400, { error: 'bad json' }); }
  const provider = PROVIDERS[input.provider];
  const list = String(input.text || '').trim().slice(0, 1000);
  if (!provider || !list) return sendJson(res, 400, { error: 'need provider (cerebras|moonshot) and text' });

  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  const send = obj => res.write(JSON.stringify(obj) + '\n');
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  send({ type: 'start', provider: input.provider, label: provider.label, model: provider.model });

  let text = '', pending = '', gifts = 0;
  const emitLine = async raw => {
    const m = raw.trim().match(LINE);
    if (!m) return;
    const [, who, name, price, store, url] = m;
    gifts++;
    send({ type: 'gift', ms: ms(), who: who.trim(), name: name.trim(), price: price.trim(), store, url, image: await imageFor(url) });
  };
  try {
    const r = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: 'POST', signal: abort.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${gatewayToken()}`, 'x-openclaw-model': provider.model },
      body: JSON.stringify({ model: 'openclaw/santa', stream: true, messages: [{ role: 'user', content: giftPrompt(list) }] }),
    });
    if (!r.ok || !r.body) throw new Error(`gateway HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let sse = '';
    for await (const chunk of r.body) {
      sse += Buffer.from(chunk).toString();
      let nl;
      while ((nl = sse.indexOf('\n')) >= 0) {
        const line = sse.slice(0, nl).trim(); sse = sse.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
        const delta = j.choices?.[0]?.delta?.content || '';
        if (!delta) continue;
        text += delta; pending += delta;
        let cut;
        while ((cut = pending.indexOf('\n')) >= 0) { await emitLine(pending.slice(0, cut)); pending = pending.slice(cut + 1); }
      }
    }
    if (pending.trim()) await emitLine(pending);
    send({ type: 'done', ms: ms(), gifts, text });
  } catch (e) {
    if (!abort.signal.aborted) send({ type: 'error', ms: ms(), message: String(e.message || e), text });
  }
  res.end();
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (pathname === '/api/run') {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    return runGifts(req, res);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
  return serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`dev server on http://${HOST}:${PORT} (serving ${ROOT})`);
});
