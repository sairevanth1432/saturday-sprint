// Practice analytics for the admin console: how many students attempted each practice question, how many got it
// right, and which options they picked. Built from progress.data (the portal saves pPick[gi] = the student's first
// answer and solved[id] = coding problems passed) and generated/practice.json (written by npm run build).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from './config.js';
import { all, parseJSON } from './db.js';
import * as kv from './kv.js';

const FILE = path.join(ROOT, 'generated', 'practice.json');
let catalogue = null, catalogueAt = 0;
function loadCatalogue() {
  try {
    const m = fs.statSync(FILE).mtimeMs;
    if (!catalogue || m !== catalogueAt) { catalogue = JSON.parse(fs.readFileSync(FILE, 'utf8')); catalogueAt = m; }
  } catch { catalogue = { quiz: [], code: [] }; }
  return catalogue;
}

const sameAnswer = (q, k) => k !== undefined && k !== null &&
  (Array.isArray(q.c) ? Array.isArray(k) && k.length === q.c.length && q.c.every((x) => k.includes(x)) : k === q.c);

// Students who count: active master rows; test students are left out on the live site, admin previews always.
const STUDENTS = `SELECT pr.roll_no, pr.data FROM progress pr JOIN students_master m ON m.roll_no = pr.roll_no
  WHERE m.active = 1 AND pr.roll_no NOT LIKE 'ADMIN-%'` + (config.isLive ? ` AND m.batch <> 'TEST'` : '');

async function compute() {
  const cat = loadCatalogue();
  const rows = await all(STUDENTS);
  const quiz = cat.quiz.map((q) => ({ ...q, attempted: 0, correct: 0, picks: q.o.map(() => 0) }));
  const byGi = new Map(quiz.map((q) => [q.gi, q]));
  const code = cat.code.map((c) => ({ ...c, solved: 0 }));
  const byId = new Map(code.map((c) => [c.id, c]));
  let active = 0;
  for (const r of rows) {
    const d = parseJSON(r.data, {});
    const picks = d.pPick && typeof d.pPick === 'object' ? d.pPick : {};
    const solved = d.solved && typeof d.solved === 'object' ? d.solved : {};
    let any = false;
    for (const [gi, k] of Object.entries(picks)) {
      const q = byGi.get(Number(gi));
      if (!q || k === null || k === undefined) continue;
      any = true; q.attempted++;
      if (sameAnswer(q, k)) q.correct++;
      for (const i of Array.isArray(k) ? k : [k]) if (Number.isInteger(i) && i >= 0 && i < q.picks.length) q.picks[i]++;
    }
    for (const [id, v] of Object.entries(solved)) { const c = byId.get(id); if (c && v) { c.solved++; any = true; } }
    if (any) active++;
  }
  // Per course + session totals, in the order the portal lists them.
  const topics = [];
  const key = (course, sess) => course + '\u0000' + sess;
  const tmap = new Map();
  const topic = (course, sess) => {
    let t = tmap.get(key(course, sess));
    if (!t) { t = { course, sess, quiz: 0, code: 0, attempts: 0, correct: 0, solved: 0 }; tmap.set(key(course, sess), t); topics.push(t); }
    return t;
  };
  for (const q of quiz) { const t = topic(q.course, q.sess); t.quiz++; t.attempts += q.attempted; t.correct += q.correct; }
  for (const c of code) { const t = topic('pf', c.topic); t.code++; t.solved += c.solved; }
  return { at: Date.now(), students: rows.length, active, quiz, code, topics };
}

// Question counts per course (public Help page).
export function practiceCounts() {
  const c = loadCatalogue(), out = {};
  for (const q of c.quiz) { out[q.course] = out[q.course] || { quiz: 0, code: 0 }; out[q.course].quiz++; }
  out.pf = out.pf || { quiz: 0, code: 0 }; out.pf.code = c.code.length;
  return out;
}

// Cached for a minute: it reads every student's progress.
export async function practiceAnalytics({ fresh = false } = {}) {
  if (fresh) await kv.invalidate('practice-analytics').catch(() => {});
  return kv.cached('practice-analytics', 60, compute, { localMs: 60000 });
}

// One question: who picked what (for the drill-down list).
export async function practiceQuestion(gi) {
  const q = loadCatalogue().quiz.find((x) => x.gi === gi);
  if (!q) return null;
  const rows = await all(STUDENTS.replace('SELECT pr.roll_no, pr.data', 'SELECT pr.roll_no, pr.data, m.name, m.batch'));
  const students = [];
  for (const r of rows) {
    const k = (parseJSON(r.data, {}).pPick || {})[gi];
    if (k === undefined || k === null) continue;
    students.push({ roll_no: r.roll_no, name: r.name, batch: r.batch, pick: k, correct: sameAnswer(q, k) });
  }
  students.sort((a, b) => a.roll_no.localeCompare(b.roll_no));
  return { question: q, students };
}
