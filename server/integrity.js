// Honeypots for coding practice (content/integrity.json → generated/integrity.json by npm run build).
// The portal reports each Submit in the code editor; the server records the metrics and FLAGS suspicious ones for
// admins (Admin → Integrity flags). Nothing is blocked and students never see a flag.
//   AI_TRAP      the code contains a token from the hidden trap line in the question text
//   PASTE_HEAVY  one paste > pasteSingleChars, or pasted characters > pasteShare of the final code
//   FAST_SOLVE   correct in < fastSolveShare of the median solve time of that question
//   BOT          the invisible form field was filled in
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { one, all, run } from './db.js';

const FILE = path.join(ROOT, 'generated', 'integrity.json');
const DEFAULTS = { enabled: true, watermark: true, trap: { instruction: '', tokens: [] }, questions: {},
  thresholds: { pasteSingleChars: 150, pasteShare: 0.6, fastSolveShare: 0.2, fastSolveMinSamples: 5 } };
let cfg = null;
export function integrityConfig() {
  if (!cfg) {
    let c = {};
    try { c = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) || {} : {}; } catch { c = {}; }
    cfg = { ...DEFAULTS, ...c, thresholds: { ...DEFAULTS.thresholds, ...(c.thresholds || {}) } };
  }
  return cfg;
}
export const setIntegrityConfigForTest = (c) => { cfg = c ? { ...DEFAULTS, ...c, thresholds: { ...DEFAULTS.thresholds, ...(c.thresholds || {}) } } : null; };
const trapFor = (qid) => { const c = integrityConfig(); return (c.questions && c.questions[qid]) || c.trap; };

// What the portal needs to show the traps (the tokens are inside the instruction text anyway).
export function clientIntegrity() {
  const c = integrityConfig();
  if (!c.enabled) return { enabled: false };
  const q = {};
  for (const [id, t] of Object.entries(c.questions || {})) q[id] = t.instruction || '';
  return { enabled: true, watermark: !!c.watermark, trap: c.trap.instruction || '', questions: q };
}

const int = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));

// body: { qid, topic, code, correct, pasteMax, pasteTotal, pasteCount, blurs, awayMs, timeMs, bot }
export async function recordSubmission(roll, b) {
  const c = integrityConfig(), T = c.thresholds;
  const qid = String(b.qid || '').slice(0, 80);
  if (!c.enabled || !qid || qid === 'play') return { ok: true, flags: 0 };
  const code = String(b.code || '').slice(0, 20000);
  const m = { correct: b.correct ? 1 : 0, timeMs: int(b.timeMs, 864e5 * 7), pasteMax: int(b.pasteMax, 1e6), pasteTotal: int(b.pasteTotal, 1e7),
    pasteCount: int(b.pasteCount, 1e5), blurs: int(b.blurs, 1e5), awayMs: int(b.awayMs, 864e5 * 7), codeLen: code.length };
  const flags = [];
  const tokens = (trapFor(qid).tokens || []).filter(Boolean);
  const hit = tokens.filter((t) => code.includes(t));
  if (hit.length) {
    const line = code.split('\n').find((l) => hit.some((t) => l.includes(t))) || '';
    flags.push(['AI_TRAP', { tokens: hit, snippet: line.trim().slice(0, 200) }]);
  }
  if (m.pasteMax > T.pasteSingleChars || (m.codeLen > 0 && m.pasteTotal / m.codeLen > T.pasteShare))
    flags.push(['PASTE_HEAVY', { pasteMax: m.pasteMax, pasteTotal: m.pasteTotal, pasteCount: m.pasteCount, codeLen: m.codeLen, share: m.codeLen ? +(m.pasteTotal / m.codeLen).toFixed(2) : null }]);
  if (m.correct && m.timeMs > 0) {
    const r = await one(`SELECT COUNT(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY time_ms) AS med
      FROM practice_submissions WHERE question_id = ? AND correct = 1 AND roll_no <> ? AND time_ms > 0`, qid, roll);
    const n = Number(r && r.n) || 0, med = Number(r && r.med) || 0;
    if (n >= T.fastSolveMinSamples && med > 0 && m.timeMs < T.fastSolveShare * med)
      flags.push(['FAST_SOLVE', { timeMs: m.timeMs, medianMs: Math.round(med), samples: n }]);
  }
  if (typeof b.bot === 'string' && b.bot.trim()) flags.push(['BOT', { value: b.bot.slice(0, 120) }]);

  const now = Date.now();
  await run(`INSERT INTO practice_submissions (roll_no, question_id, topic, correct, time_ms, paste_max, paste_total, paste_count, code_len, blurs, away_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, roll, qid, String(b.topic || '').slice(0, 120), m.correct, m.timeMs, m.pasteMax, m.pasteTotal, m.pasteCount, m.codeLen, m.blurs, m.awayMs, now);
  // One flag per student, question and type: later submits of the same question do not repeat it.
  for (const [type, ev] of flags) {
    if (await one('SELECT 1 AS x FROM integrity_flags WHERE roll_no = ? AND question_id = ? AND flag_type = ? LIMIT 1', roll, qid, type)) continue;
    await run('INSERT INTO integrity_flags (roll_no, question_id, flag_type, evidence, created_at) VALUES (?, ?, ?, ?, ?)',
      roll, qid, type, JSON.stringify({ ...ev, correct: !!m.correct, timeMs: m.timeMs, blurs: m.blurs, awayMs: m.awayMs }), now);
  }
  return { ok: true, flags: flags.length };
}

export const FLAG_TYPES = ['AI_TRAP', 'PASTE_HEAVY', 'FAST_SOLVE', 'BOT'];
export async function listFlags({ type, from, to, roll } = {}) {
  const where = [], p = [];
  if (FLAG_TYPES.includes(type)) { where.push('f.flag_type = ?'); p.push(type); }
  if (Number(from)) { where.push('f.created_at >= ?'); p.push(Number(from)); }
  if (Number(to)) { where.push('f.created_at < ?'); p.push(Number(to)); }
  if (roll) { where.push('f.roll_no = ?'); p.push(String(roll)); }
  const rows = await all(`SELECT f.id, f.roll_no, m.name, m.batch, f.question_id, f.flag_type, f.evidence, f.created_at
    FROM integrity_flags f LEFT JOIN students_master m ON m.roll_no = f.roll_no
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY f.created_at DESC LIMIT 2000`, ...p);
  const counts = await all('SELECT flag_type, COUNT(*) AS n, COUNT(DISTINCT roll_no) AS students FROM integrity_flags GROUP BY flag_type');
  return { rows: rows.map((r) => ({ ...r, evidence: safeJSON(r.evidence) })), counts, types: FLAG_TYPES };
}
const safeJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };
