#!/usr/bin/env node
// Synthesizes the app's UI sounds (original, no samples): clean store-style cues instead of cartoon effects.
// Writes public/sfx/ui-*.wav (48 kHz, 16-bit mono). Usage: node tools/make-sfx.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 48000;
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sfx');
mkdirSync(out, { recursive: true });
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

// a struck tone: a few partials, fast attack, exponential decay (higher partials die faster)
function tone(buf, at, f, { amp = 1, tau = 0.25, partials = [[1, 1], [2, 0.18], [3, 0.05]], attack = 0.002 } = {}) {
  const i0 = Math.round(at * SR), n = Math.min(buf.length - i0, Math.round(tau * 7 * SR));
  for (let i = 0; i < n; i++) {
    const t = i / SR, a = Math.min(1, t / attack);
    let v = 0;
    for (const [k, g] of partials) v += g * Math.sin(2 * Math.PI * f * k * t) * Math.exp(-t / (tau / Math.sqrt(k)));
    buf[i0 + i] += amp * a * v;
  }
}
// a short filtered noise tick: the "physical" click on top of a tone
function click(buf, at, { amp = 0.25, len = 0.006, hp = 0.85 } = {}) {
  const i0 = Math.round(at * SR); let prev = 0, y = 0;
  for (let i = 0; i < len * SR; i++) { const x = rnd(); y = hp * (y + x - prev); prev = x; buf[i0 + i] += amp * y * Math.exp(-i / (len * SR / 3)); }
}
// a thump: a low sine that drops in pitch, for weight under a click
function thump(buf, at, { f0 = 180, f1 = 90, amp = 0.5, tau = 0.05 } = {}) {
  const i0 = Math.round(at * SR); let ph = 0;
  for (let i = 0; i < tau * 6 * SR; i++) { const t = i / SR, f = f1 + (f0 - f1) * Math.exp(-t / 0.03); ph += 2 * Math.PI * f / SR; buf[i0 + i] += amp * Math.sin(ph) * Math.exp(-t / tau); }
}
// an airy rising sweep: noise through a band-pass whose center climbs
function sweep(buf, at, { dur = 0.32, f0 = 500, f1 = 5000, amp = 0.35, q = 2.5 } = {}) {
  const i0 = Math.round(at * SR), n = Math.round(dur * SR); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < n; i++) {
    const p = i / n, fc = f0 * Math.pow(f1 / f0, p), w = 2 * Math.PI * fc / SR, al = Math.sin(w) / (2 * q);
    const b0 = al, b2 = -al, a0 = 1 + al, a1 = -2 * Math.cos(w), a2 = 1 - al;
    const x = rnd(), y = (b0 * x + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    buf[i0 + i] += amp * y * Math.sin(Math.PI * p) ** 1.5;
  }
}
// small room: Schroeder reverb (4 combs, 2 all-passes), mixed in lightly
function room(buf, mix = 0.12) {
  const wet = new Float32Array(buf.length);
  for (const [d, g] of [[1557, .78], [1617, .77], [1491, .79], [1422, .8]]) {
    const dl = Math.round(d * SR / 44100), line = new Float32Array(dl); let k = 0;
    for (let i = 0; i < buf.length; i++) { const y = line[k]; line[k] = buf[i] + y * g; k = (k + 1) % dl; wet[i] += y / 4; }
  }
  for (const d of [225, 556]) {
    const dl = Math.round(d * SR / 44100), line = new Float32Array(dl); let k = 0;
    for (let i = 0; i < buf.length; i++) { const z = line[k], y = -wet[i] * .5 + z; line[k] = wet[i] + z * .5; k = (k + 1) % dl; wet[i] = y; }
  }
  for (let i = 0; i < buf.length; i++) buf[i] += mix * wet[i];
}
function save(name, buf, peakDb = -1) {
  room(buf);
  let pk = 0; for (const v of buf) pk = Math.max(pk, Math.abs(v));
  const g = Math.pow(10, peakDb / 20) / (pk || 1);
  const n = buf.length, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  // 5 ms fade out at the very end so nothing clicks when the file stops
  for (let i = 0; i < n; i++) { const f = Math.min(1, (n - i) / (0.005 * SR)); b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, buf[i] * g * f)) * 32767), 44 + i * 2); }
  writeFileSync(join(out, `ui-${name}.wav`), b);
  console.log(`ui-${name}.wav ${(n / SR).toFixed(2)}s`);
}
const len = s => new Float32Array(Math.round(s * SR));

// gift lands in the cart: a soft wooden "tock" with a bright glassy top
{ const b = len(0.45); click(b, 0, { amp: 0.35, len: 0.004 }); thump(b, 0, { f0: 320, f1: 200, amp: 0.35, tau: 0.03 });
  tone(b, 0.002, 1567.98, { amp: 0.55, tau: 0.09, partials: [[1, 1], [2.01, 0.22], [3.02, 0.06]] }); save('add', b); }

// the Cerebras switch: a firm toggle click plus a quick rising air sweep
{ const b = len(0.55); click(b, 0, { amp: 0.6, len: 0.005 }); thump(b, 0, { f0: 220, f1: 110, amp: 0.7, tau: 0.04 });
  sweep(b, 0.01, { dur: 0.3, f0: 600, f1: 6500, amp: 0.4 }); tone(b, 0.02, 987.77, { amp: 0.18, tau: 0.08 }); save('switch', b); }

// all gifts in the cart: a bright "payment done" chime, three quick rising bell notes over a soft thump
{ const b = len(1.8); thump(b, 0, { f0: 160, f1: 80, amp: 0.45, tau: 0.08 });
  const bell = [[1, 1], [2.76, 0.12], [5.4, 0.04], [2, 0.2]];
  tone(b, 0.0, 1318.51, { amp: 0.55, tau: 0.35, partials: bell });   // E6
  tone(b, 0.075, 1567.98, { amp: 0.55, tau: 0.38, partials: bell });  // G6
  tone(b, 0.15, 2093.0, { amp: 0.7, tau: 0.55, partials: bell });     // C7
  save('done', b); }

// a plain UI tap (opening AI Shopper)
{ const b = len(0.2); click(b, 0, { amp: 0.5, len: 0.004 }); thump(b, 0, { f0: 260, f1: 160, amp: 0.3, tau: 0.02 }); save('tap', b, -4); }
