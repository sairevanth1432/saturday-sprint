// Makes public/music/lofi-loop.wav: a seamless lo-fi chiptune loop for the learning portal.
//   92 BPM, 4/4, eight bars: Am · F · C · G, two bars each (20.9 s). Soft triangle bass on the root, a quiet
//   square-wave pad with the chord, a gentle arpeggio, a light hi-hat on the off-beats, a little tape hiss.
//   Everything is synthesised here, no samples, no dependencies. Re-run with `node scripts/make-music.js`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'music', 'lofi-loop.wav');

const SR = 44100, BPM = 92, BEAT = 60 / BPM, BAR = BEAT * 4;
const CHORDS = [ // semitones from A2 for bass; chord notes as MIDI
  { name: 'Am', bass: 45, notes: [57, 60, 64], arp: [57, 60, 64, 69] },
  { name: 'F', bass: 41, notes: [53, 57, 60], arp: [53, 57, 60, 65] },
  { name: 'C', bass: 48, notes: [55, 60, 64], arp: [48, 55, 60, 64] },
  { name: 'G', bass: 43, notes: [55, 59, 62], arp: [55, 59, 62, 67] }
];
const BARS_PER_CHORD = 2, LEN = CHORDS.length * BARS_PER_CHORD * BAR;
const N = Math.round(LEN * SR);
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

const out = new Float64Array(N);
const add = (i, v) => { if (i >= 0 && i < N) out[i] += v; };

// --- voices
function tri(ph) { return 2 * Math.abs(2 * (ph - Math.floor(ph + 0.5))) - 1; }
function sq(ph, duty = 0.5) { return (ph - Math.floor(ph)) < duty ? 1 : -1; }
function env(t, a, d, s, r, len) { // ADSR, t in seconds within the note
  if (t < a) return t / a;
  if (t < a + d) return 1 - (1 - s) * ((t - a) / d);
  if (t < len - r) return s;
  return Math.max(0, s * (1 - (t - (len - r)) / r));
}
// A one-pole low-pass keeps the squares soft (lo-fi).
function lowpass(buf, cutoff) {
  const rc = 1 / (2 * Math.PI * cutoff), dt = 1 / SR, a = dt / (rc + dt);
  let y = 0;
  for (let i = 0; i < buf.length; i++) { y += a * (buf[i] - y); buf[i] = y; }
}

function note(startSec, lenSec, freq, gain, wave, duty, a, d, s, r) {
  const i0 = Math.round(startSec * SR), n = Math.round(lenSec * SR);
  for (let k = 0; k < n; k++) {
    const t = k / SR, ph = freq * t;
    const w = wave === 'sq' ? sq(ph, duty) : wave === 'tri' ? tri(ph) : Math.sin(2 * Math.PI * ph);
    add((i0 + k) % N, w * gain * env(t, a, d, s, r, lenSec)); // wraps so the tail of the last note lands at the start: seamless loop
  }
}
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
function hat(startSec, gain, lenSec = 0.05) {
  const i0 = Math.round(startSec * SR), n = Math.round(lenSec * SR);
  let hp = 0, prev = 0;
  for (let k = 0; k < n; k++) {
    const w = rnd() * 2 - 1; hp = w - prev + 0.7 * hp; prev = w; // crude high-pass → "ts"
    add((i0 + k) % N, hp * gain * Math.pow(1 - k / n, 2.2));
  }
}
function kick(startSec, gain) {
  const i0 = Math.round(startSec * SR), n = Math.round(0.22 * SR);
  for (let k = 0; k < n; k++) { const t = k / SR, f = 48 + 90 * Math.exp(-t * 28); add((i0 + k) % N, Math.sin(2 * Math.PI * f * t) * gain * Math.exp(-t * 11)); }
}

// --- arrangement
const pad = new Float64Array(N); // rendered separately so it can be low-passed harder
for (let c = 0; c < CHORDS.length; c++) {
  const ch = CHORDS[c], t0 = c * BARS_PER_CHORD * BAR, span = BARS_PER_CHORD * BAR;
  // pad: the chord as quiet square waves with slow attack, held for the two bars
  for (const m of ch.notes) {
    const i0 = Math.round(t0 * SR), n = Math.round(span * SR);
    for (let k = 0; k < n; k++) { const t = k / SR; pad[(i0 + k) % N] += sq(hz(m) * t + m * 0.13, 0.33) * 0.030 * env(t, 0.9, 0.5, 0.85, 1.2, span); }
  }
  for (let bar = 0; bar < BARS_PER_CHORD; bar++) {
    const b0 = t0 + bar * BAR;
    // bass: root on 1 and the "and" of 2, fifth on 4 (triangle, soft)
    note(b0, BEAT * 0.95, hz(ch.bass), 0.20, 'tri', 0.5, 0.01, 0.15, 0.7, 0.12);
    note(b0 + BEAT * 1.5, BEAT * 0.45, hz(ch.bass), 0.15, 'tri', 0.5, 0.01, 0.1, 0.6, 0.08);
    note(b0 + BEAT * 3, BEAT * 0.9, hz(ch.bass + 7), 0.14, 'tri', 0.5, 0.01, 0.15, 0.6, 0.12);
    // arpeggio: eighth notes, square at 25% duty, very quiet, up-down pattern, only on the second bar of each chord
    if (bar === 1) {
      const seq = [0, 1, 2, 3, 2, 1, 0, 1];
      seq.forEach((ix, k) => note(b0 + k * BEAT / 2, BEAT * 0.42, hz(ch.arp[ix] + 12), 0.040, 'sq', 0.25, 0.005, 0.08, 0.5, 0.06));
    } else {
      // first bar: a sparse two-note motif
      note(b0 + BEAT * 2.5, BEAT * 0.4, hz(ch.arp[2] + 12), 0.035, 'sq', 0.25, 0.005, 0.08, 0.5, 0.06);
      note(b0 + BEAT * 3.5, BEAT * 0.4, hz(ch.arp[3] + 12), 0.035, 'sq', 0.25, 0.005, 0.08, 0.5, 0.06);
    }
    // drums: soft kick on 1 and 3, light hats on every off-beat, a ghost hat on the "a" of 4
    kick(b0, 0.22); kick(b0 + BEAT * 2, 0.17);
    for (let e = 0; e < 4; e++) hat(b0 + BEAT * (e + 0.5), 0.045);
    hat(b0 + BEAT * 3.75, 0.025, 0.03);
  }
}
lowpass(pad, 1400);
for (let i = 0; i < N; i++) out[i] += pad[i];
lowpass(out, 5200); // overall warmth
// tape hiss, barely there
for (let i = 0; i < N; i++) out[i] += (rnd() * 2 - 1) * 0.0035;

// --- normalise and write a 16-bit mono WAV
let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[i]));
const g = 0.72 / peak;
const pcm = Buffer.alloc(N * 2);
for (let i = 0; i < N; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out[i] * g * 32767))), i * 2);
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([header, pcm]));
console.log(`Music → ${path.relative(ROOT, OUT)} (${LEN.toFixed(1)} s, ${BPM} BPM, ${CHORDS.map((c) => c.name).join(' · ')}, ${(pcm.length / 1048576).toFixed(1)} MB)`);
