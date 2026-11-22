#!/usr/bin/env node
// Minimal stdio MCP server exposing one tool, find_gifts, for the speed run.
// It searches Shop MCP (keyless Shopify catalog) for every person in parallel in ONE tool call,
// and returns a compact list, so the agent needs one round trip and the next turn stays small.
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHOP_URL = 'https://mcp.shop.com';
const SHOP_PROTOCOL = '2026-07-28';
const PER_PERSON = Number(process.env.GIFT_RESULTS_PER_PERSON || 3);
const INCLUDE_IMAGES = process.env.GIFT_INCLUDE_IMAGES === '1';
const LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');

const TOOL = {
  name: 'find_gifts',
  description: 'Search real online stores for gift ideas. Pass every person at once; searches run in parallel. Returns real products with price, store and product page URL.',
  inputSchema: {
    type: 'object',
    properties: {
      people: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            who: { type: 'string', description: 'Person, e.g. "sister"' },
            query: { type: 'string', description: 'Product search, e.g. "climbing chalk bag"' },
            max_usd: { type: 'number', description: 'Optional budget in USD' },
          },
          required: ['who', 'query'],
        },
      },
    },
    required: ['people'],
  },
};

let rpcId = 0;
async function shopSearch(query, maxUsd) {
  // ask for a few extra: the catalog sometimes returns stores priced in other currencies, which we drop
  const catalog = { query, context: { address_country: 'US', currency: 'USD' }, pagination: { limit: PER_PERSON + 4 } };
  if (maxUsd) catalog.filters = { price: { max: Math.round(maxUsd * 100) } };
  // one retry: a stuck search would otherwise stall the whole run until OpenClaw's tool timeout
  for (let attempt = 0; ; attempt++) {
    try { return await shopRequest(catalog); }
    catch (e) { if (attempt >= 1) throw e; }
  }
}

async function shopRequest(catalog) {
  const res = await fetch(SHOP_URL, {
    signal: AbortSignal.timeout(6000),
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': SHOP_PROTOCOL,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'search_catalog',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: ++rpcId, method: 'tools/call',
      params: {
        _meta: { 'io.modelcontextprotocol/protocolVersion': SHOP_PROTOCOL, 'io.modelcontextprotocol/clientCapabilities': {} },
        name: 'search_catalog', arguments: { catalog },
      },
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return (j.result?.structuredContent?.products || []).map(p => {
    const v = (p.variants || []).find(x => x.availability?.available) || p.variants?.[0] || {};
    if (v.price?.currency && v.price.currency !== 'USD') return null;
    let url = v.url || '';
    try { const u = new URL(url); for (const k of [...u.searchParams.keys()]) if (k.startsWith('utm_') || k === '_gsid') u.searchParams.delete(k); url = u.toString(); } catch {}
    return {
      title: p.title,
      price: v.price ? `${(v.price.amount / 100).toFixed(2)} ${v.price.currency}` : null,
      store: url ? new URL(url).hostname.replace(/^www\./, '') : null,
      url,
      image: p.media?.[0]?.url || null,
    };
  }).filter(Boolean).slice(0, PER_PERSON);
}

async function findGifts({ people = [] }) {
  const out = await Promise.all(people.map(async p => {
    try { return { who: p.who, results: await shopSearch(p.query, p.max_usd) }; }
    catch (e) { return { who: p.who, error: String(e.message || e) }; }
  }));
  const products = out.flatMap(o => o.results || []);
  // record what we returned: the runners check the answer copied real links exactly,
  // and the app looks up each picked product's image by URL
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const at = new Date().toISOString();
    // cumulative (newest 5000), so parallel runs don't overwrite each other's record
    let seen = [];
    try { seen = JSON.parse(readFileSync(join(LOG_DIR, 'last-urls.json'), 'utf8')).urls || []; } catch {}
    const urls = [...new Set([...products.map(r => r.url), ...seen])].slice(0, 5000);
    writeFileSync(join(LOG_DIR, 'last-urls.json'), JSON.stringify({ at, urls }));
    writeFileSync(join(LOG_DIR, 'last-results.json'), JSON.stringify({ at, products }));
  } catch {}
  // images are a third of the payload and the model never uses them, so they stay out of the model's context
  if (!INCLUDE_IMAGES) for (const r of products) delete r.image;
  return JSON.stringify(out);
}

// ---- JSON-RPC over stdio (newline-delimited) ----
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const rl = createInterface({ input: process.stdin });
rl.on('line', async line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return; // notifications
  const ok = result => send({ jsonrpc: '2.0', id: m.id, result });
  try {
    if (m.method === 'initialize') return ok({
      protocolVersion: m.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'gift-search', version: '0.1.0' },
    });
    if (m.method === 'tools/list') return ok({ tools: [TOOL] });
    if (m.method === 'tools/call') {
      if (m.params?.name !== 'find_gifts') throw new Error('unknown tool');
      return ok({ content: [{ type: 'text', text: await findGifts(m.params.arguments || {}) }] });
    }
    if (m.method === 'ping') return ok({});
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
  } catch (e) {
    ok({ content: [{ type: 'text', text: String(e.message || e) }], isError: true });
  }
});
