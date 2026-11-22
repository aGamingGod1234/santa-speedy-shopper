#!/usr/bin/env node
// Records the real app (standard OpenClaw, no speed patch) doing the video's screen segment, unattended:
// fresh page, the list sent on Moonshot API, S to flip to Cerebras, Enter to resend the same list, E for the end card.
// Each attempt becomes its own clip, recordings/seg-<SGT time>-moon<s>-cer<s>.mp4 (1620x1440, 30 fps, H.264),
// so the fastest Cerebras take can be swapped into the edit at any time. Every number on screen comes from that run.
// Usage: node scripts/record-segment.mjs [--good 3] [--max-cer 10] [--attempts 12] [--until 2026-11-22T19:30+08:00] [--gap-sec 60]
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
  until: { type: 'string', default: '2026-11-22T19:30+08:00' }, 'gap-sec': { type: 'string', default: '60' },
} });
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || join(process.env.TEMP, 'santa-kit-render', 'node_modules', 'playwright'));
const FFMPEG = process.env.FFMPEG || 'C:/Users/User/tools/asr/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v9.0.2.exe';
const APP = 'http://127.0.0.1:3000/?clean=1&countdown=1';
const LIST = 'my mom loves coffee, my dad is into music, my sister climbs, my brother games, and grandma reads mystery novels';
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

async function attempt(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1080, height: 960 }, deviceScaleFactor: 1.5 });
  const page = await ctx.newPage();
  await page.goto(APP);
  await page.waitForLoadState('networkidle');
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
  // without maxWidth/maxHeight the frames come at CSS size (1080x960) instead of device pixels
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: 1620, maxHeight: 1440, everyNthFrame: 1 });
  await sleep(1200);
  await page.evaluate(l => { showText(l); send(l, false); }, LIST);   // same as typing the list and pressing Enter
  const moon = await waitRun(page, 'slow');
  let cer = null;
  if (moon) {
    await sleep(1500);
    await page.keyboard.press('s');
    await sleep(700);
    await page.keyboard.press('Enter');
    cer = await waitRun(page, 'fast');
    if (cer) { await sleep(2200); await page.keyboard.press('e'); await sleep(3500); }
  }
  await cdp.send('Page.stopScreencast').catch(() => {});
  await sleep(300);
  await ctx.close();
  let clip = null;
  if (moon && cer && frames.length > 10) {
    // frames arrive only when the page changes: give each one its real on-screen duration, then resample to 30 fps
    const list = frames.map((f, i) => `file '${f.file.replace(/\\/g, '/')}'\nduration ${Math.max(0.001, ((frames[i + 1]?.t ?? f.t + 0.1) - f.t)).toFixed(4)}`).join('\n')
      + `\nfile '${frames.at(-1).file.replace(/\\/g, '/')}'\n`;
    const listFile = join(frameDir, 'list.txt');
    writeFileSync(listFile, list);
    clip = join(outDir, `seg-${sgt()}-moon${moon.toFixed(1)}-cer${cer.toFixed(1)}.mp4`);
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', 'fps=30,scale=in_range=pc:out_range=tv,format=yuv420p', '-color_range', 'tv',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-movflags', '+faststart', clip]);
  }
  const span = frames.length > 1 ? frames.at(-1).t - frames[0].t : 0;
  rmSync(frameDir, { recursive: true, force: true });
  return { moon, cer, clip, fps: span ? (frames.length / span).toFixed(1) : '-' };
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
    note(`attempt ${i}: moonshot ${r.moon?.toFixed(1) ?? 'failed'}s | cerebras ${r.cer?.toFixed(1) ?? 'failed'}s | ${r.fps} captured fps | ${ok ? 'GOOD' : 'slow'} ${r.clip ? r.clip : '(no clip)'}`);
  } catch (e) { note(`attempt ${i}: error ${e.message.split('\n')[0]}`); }
}
await browser.close();
note(`finished: ${good} clips with Cerebras under ${a['max-cer']}s`);
