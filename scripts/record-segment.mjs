#!/usr/bin/env node
// Records the real app (standard OpenClaw, no speed patch) doing the video's screen segment, unattended:
// home page, click AI Shopper, type the list, Moonshot API run, click Cerebras, resend the same list, order summary.
// Each attempt becomes its own 4K clip (3840x2160, 30 fps, H.264, with the app's sound effects mixed in at the moments
// they played): recordings/seg-<SGT time>-moon<s>-cer<s>.mp4. Every product, price, store and time comes from that run;
// only the shop clock is set (?clock=23:58:00), as the skit's story time.
// Usage: node scripts/record-segment.mjs [--good 3] [--max-cer 10] [--attempts 12] [--until 2026-11-22T21:30+08:00] [--gap-sec 45]
// Needs the app server (npm start) and the standard gateway running, Playwright + Edge, and ffmpeg (FFMPEG env or the asr venv copy).
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: a } = parseArgs({ strict: true, options: {
  good: { type: 'string', default: '3' }, 'max-cer': { type: 'string', default: '10' }, attempts: { type: 'string', default: '12' },
  until: { type: 'string', default: '2026-11-22T21:30+08:00' }, 'gap-sec': { type: 'string', default: '45' },
  // only the switch and the Cerebras run, for swapping the fastest one into a hand-recorded take: the list sits in the
  // search bar unsent, then Cerebras is clicked and the same list is sent there
  'cer-only': { type: 'boolean', default: false },
  sfx: { type: 'string', default: 'store' },   // the app's sound set: store (default), or the older A, B, C
} });
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || join(process.env.TEMP, 'santa-kit-render', 'node_modules', 'playwright'));
const FFMPEG = process.env.FFMPEG || 'C:/Users/User/tools/asr/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v9.0.2.exe';
const APP = `http://127.0.0.1:3000/?clean=1&cursor=1&sound=0&clock=23:58:00&sfx=${a.sfx}`;
const LIST = 'my mom loves coffee, my dad is into music, my sister climbs, my brother games, and grandma reads mystery novels';
const sfxDir = join(root, 'public', 'sfx');
const outDir = join(root, 'recordings');
const log = join(outDir, 'segments.log');
mkdirSync(outDir, { recursive: true });
const sgt = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 16).replace(':', '');
const note = s => { const line = `${new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')} SGT ${s}`; console.log(line); appendFileSync(log, line + '\n'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitRun(page, side, timeoutMs = 150000) {
  const t0 = Date.now();
  await sleep(500);
  while (Date.now() - t0 < timeoutMs) {
    // a failed run ends with running false and no time for that side
    const s = await page.evaluate(side => ({ running, t: times[side] }), side).catch(() => ({ running: true }));
    if (!s.running) return s.t ?? null;
    await sleep(200);
  }
  return null;
}

// glide the drawn cursor (the screencast has no OS cursor) to an element, then click it for real
async function clickEl(page, sel) {
  const b = await page.locator(sel).boundingBox();
  const x = b.x + b.width / 2, y = b.y + b.height / 2, k = 1280 / 3840;   // the drawn cursor lives in canvas pixels
  await page.evaluate(([x, y]) => __cursor(x, y), [x * k, y * k]);
  await sleep(650);
  await page.evaluate(([x, y]) => __cursor(x, y, true), [x * k, y * k]);
  await page.mouse.click(x, y);
}

async function attempt(browser) {
  // a 4K viewport: the app scales its 1280x720 canvas 3x, so text and images render sharp (the screencast ignores deviceScaleFactor)
  const ctx = await browser.newContext({ viewport: { width: 3840, height: 2160 } });
  const page = await ctx.newPage();
  await page.goto(APP);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => __cursor(900, 520));
  await sleep(1500);
  const frameDir = join(outDir, `.frames-${Date.now()}`);
  mkdirSync(frameDir);
  const frames = [];
  const cdp = await ctx.newCDPSession(page);
  cdp.on('Page.screencastFrame', async f => {
    const file = join(frameDir, `${String(frames.length).padStart(6, '0')}.jpg`);
    writeFileSync(file, Buffer.from(f.data, 'base64'));
    frames.push({ file, t: f.metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  // without maxWidth/maxHeight the frames come at CSS size instead of device pixels
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 3840, maxHeight: 2160, everyNthFrame: 1 });
  await sleep(1500);
  await clickEl(page, '#aiTab');
  await sleep(900);
  let moon = null;
  if (a['cer-only']) {
    await page.evaluate(l => { lastText = l; }, LIST);
    moon = -1;
  } else {
    await clickEl(page, '#msg');
    await page.keyboard.type(LIST, { delay: 28 });
    await sleep(400);
    await page.keyboard.press('Enter');
    moon = await waitRun(page, 'slow');
  }
  let cer = null, failText = '';
  if (moon) {
    await sleep(1400);
    await clickEl(page, '.opt.f');
    await sleep(800);
    await page.keyboard.press('Enter');   // resends the same list ("same list, resent")
    cer = await waitRun(page, 'fast', 45000);   // a Cerebras run slower than this is no use for the video
    if (!cer) failText = await page.evaluate(() => [...document.querySelectorAll('.st')].at(-1)?.textContent).catch(() => '');
    if (cer) { await sleep(2500); await page.keyboard.press('e'); await sleep(8500); }   // the finale runs about 8 s
  }
  await cdp.send('Page.stopScreencast').catch(() => {});
  await sleep(300);
  const events = await page.evaluate(() => window.__events).catch(() => []);
  await ctx.close();
  let clip = null;
  if (moon && (moon > 0 || cer) && frames.length > 10) {   // a clip is kept even when the Cerebras half fails, for the Moonshot part
    // frames arrive only when the page changes: give each one its real on-screen duration, then resample to 30 fps
    const list = frames.map((f, i) => `file '${f.file.replace(/\\/g, '/')}'\nduration ${Math.max(0.001, ((frames[i + 1]?.t ?? f.t + 0.1) - f.t)).toFixed(4)}`).join('\n')
      + `\nfile '${frames.at(-1).file.replace(/\\/g, '/')}'\n`;
    const listFile = join(frameDir, 'list.txt');
    writeFileSync(listFile, list);
    clip = join(outDir, `seg-${sgt()}${moon > 0 ? '-moon' + moon.toFixed(1) : ''}-cer${cer ? cer.toFixed(1) : 'failed'}.mp4`);
    // sound effects at the moments the page played them (event times and frame times share the wall clock)
    const start = frames[0].t * 1000, end = frames.at(-1).t * 1000;
    const ins = [], parts = [];
    for (const e of events) {
      const at = Math.round(e.t - start);
      if (at < 0) continue;
      // the page logs every sound it plays with its file, pitch (playback rate) and volume
      if (e.file) { ins.push('-i', join(sfxDir, e.file)); parts.push({ at, vol: e.vol, rate: e.rate || 1 }); }
    }
    const args = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, ...ins];
    if (parts.length) {
      // playback rate = resample, like the browser does (pitch and speed together)
      const fl = parts.map((p, i) => `[${i + 1}:a]aresample=44100,${p.rate !== 1 ? `asetrate=${Math.round(44100 * p.rate)},aresample=44100,` : ''}volume=${p.vol},adelay=${p.at}|${p.at}[a${i}]`).join(';')
        + `;${parts.map((_, i) => `[a${i}]`).join('')}amix=inputs=${parts.length}:normalize=0:duration=longest,atrim=0:${((end - start) / 1000).toFixed(2)}[aout]`;
      args.push('-filter_complex', fl, '-map', '0:v', '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
    }
    args.push('-vf', 'fps=30,scale=in_range=pc:out_range=tv,format=yuv420p', '-color_range', 'tv',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-movflags', '+faststart', clip);
    execFileSync(FFMPEG, args);
  }
  const span = frames.length > 1 ? frames.at(-1).t - frames[0].t : 0;
  rmSync(frameDir, { recursive: true, force: true });
  return { moon, cer, clip, failText, fps: span ? (frames.length / span).toFixed(1) : '-' };
}

const until = Date.parse(a.until);
const browser = await chromium.launch({ channel: 'msedge' });
let good = 0;
for (let i = 1; i <= Number(a.attempts) && good < Number(a.good) && Date.now() < until; i++) {
  if (i > 1) await sleep(Number(a['gap-sec']) * 1000);
  try {
    const r = await attempt(browser);
    const ok = r.cer != null && r.cer <= Number(a['max-cer']);
    if (ok) good++;
    note(`attempt ${i}: moonshot ${r.moon === -1 ? 'skipped ' : r.moon?.toFixed(1) ?? 'failed'}s | cerebras ${r.cer?.toFixed(1) ?? 'failed'}s | ${r.fps} captured fps | ${ok ? 'GOOD' : 'slow'} ${r.clip ? r.clip : '(no clip)'}${r.failText ? ' | ' + r.failText : ''}`);
  } catch (e) { note(`attempt ${i}: error ${e.message.split('\n')[0]}`); }
}
await browser.close();
note(`finished: ${good} clips with Cerebras under ${a['max-cer']}s`);
