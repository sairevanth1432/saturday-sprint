// Practice questions added by admins (Admin → Practice questions): MCQs and coding problems per course and topic.
// The portal appends them after its built-in questions (portal-bridge.js). Students' MCQ answers are stored by
// position (pPick[gi]), so questions are never removed from the list: "Delete" archives a question (it disappears
// from Practice but keeps its slot), and new ones always go at the end.
import { one, all, run, parseJSON } from './db.js';
import * as kv from './kv.js';
import { parseImport } from './practice-import.js';

export const PRACTICE_COURSES = { pf: 'Programming Foundations', genai: 'Intro to GenAI', wad: 'Web Application Development' };
export class PracticeError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const clean = (s, max) => String(s == null ? '' : s).replace(/\r\n/g, '\n').trim().slice(0, max);
const line = (s, max) => clean(s, max).replace(/\s+/g, ' ');

function checkMcq(b) {
  const course = String(b.course || ''), topic = line(b.topic, 120), q = clean(b.q, 2000), code = clean(b.code, 5000);
  const o = (Array.isArray(b.o) ? b.o : []).map((x) => clean(x, 500)).filter(Boolean);
  const c = Number(b.c), why = clean(b.why, 2000);
  if (!PRACTICE_COURSES[course]) throw new PracticeError('BAD_COURSE', 'Choose the course.');
  if (topic.length < 2) throw new PracticeError('BAD_TOPIC', 'Give the topic name.');
  if (q.length < 3) throw new PracticeError('BAD_QUESTION', 'Write the question.');
  if (o.length < 2 || o.length > 6) throw new PracticeError('BAD_OPTIONS', 'Give 2 to 6 options.');
  if (new Set(o.map((x) => x.toLowerCase())).size !== o.length) throw new PracticeError('BAD_OPTIONS', 'Two options are the same.');
  if (!Number.isInteger(c) || c < 0 || c >= o.length) throw new PracticeError('BAD_ANSWER', 'Choose the correct option.');
  return { course, topic, data: { q, code, o, c, why } };
}
function checkCode(b) {
  const course = String(b.course || 'pf'), topic = line(b.topic, 120), title = line(b.title, 160), text = clean(b.text, 20000);
  const level = ['easy', 'medium', 'hard'].includes(b.level) ? b.level : 'medium', starter = clean(b.starter, 5000);
  const tests = (Array.isArray(b.tests) ? b.tests : []).map((t) => [String((t && t.input) ?? (Array.isArray(t) ? t[0] : '')).replace(/\r\n/g, '\n').slice(0, 5000),
    String((t && t.output) ?? (Array.isArray(t) ? t[1] : '')).replace(/\r\n/g, '\n').slice(0, 5000), !!((t && t.hidden) ?? (Array.isArray(t) ? t[2] : false))]);
  if (!PRACTICE_COURSES[course]) throw new PracticeError('BAD_COURSE', 'Choose the course.');
  if (topic.length < 2) throw new PracticeError('BAD_TOPIC', 'Give the topic name.');
  if (title.length < 2) throw new PracticeError('BAD_TITLE', 'Give the problem a title.');
  if (text.length < 10) throw new PracticeError('BAD_TEXT', 'Write the problem statement.');
  if (!tests.length || tests.length > 30) throw new PracticeError('BAD_TESTS', 'Add 1 to 30 test cases.');
  if (tests.some((t) => !t[1].trim())) throw new PracticeError('BAD_TESTS', 'Every test case needs an expected output.');
  if (!tests.some((t) => !t[2])) throw new PracticeError('BAD_TESTS', 'Make at least one test case visible (a sample).');
  return { course, topic, data: { title, text, level, starter, tests } };
}

const CACHE = 'practiceq:v1';
export const clearPracticeCache = () => kv.invalidate(CACHE);
// For the portal: every question in creation order (archived ones as placeholders that Practice never shows).
export const practiceExtra = () => kv.cached(CACHE, 30, async () => {
  const rows = await all('SELECT id, kind, course, topic, data, archived, draft FROM practice_questions ORDER BY id');
  const mcq = [], code = [];
  for (const r of rows) {
    const d = parseJSON(r.data, {}) || {};
    if (r.kind === 'mcq') mcq.push(r.archived || r.draft ? { course: '', sess: '', q: '', o: [], c: 0, why: '', xid: Number(r.id) }
      : { course: r.course, sess: r.topic, q: d.q, code: d.code || undefined, o: d.o, c: d.c, why: d.why || '', xid: Number(r.id) });
    else if (!r.archived && !r.draft) code.push({ id: 'x' + r.id, topic: r.topic, title: d.title, level: d.level, text: d.text, starter: d.starter || '', tests: d.tests });
  }
  return { mcq, code };
}, { localMs: 10000 });

export async function listPractice() {
  const rows = await all('SELECT * FROM practice_questions ORDER BY id DESC');
  return rows.map((r) => ({ id: Number(r.id), kind: r.kind, course: r.course, topic: r.topic, archived: !!r.archived, draft: !!r.draft, srcId: r.src_id || '', data: parseJSON(r.data, {}),
    createdAt: r.created_at, updatedAt: r.updated_at, by: r.updated_by }));
}
export async function addPractice(kind, b, by) {
  if (!['mcq', 'code'].includes(kind)) throw new PracticeError('BAD_KIND', 'Choose MCQ or coding.');
  const v = kind === 'mcq' ? checkMcq(b) : checkCode(b), now = Date.now();
  const r = await one('INSERT INTO practice_questions (kind, course, topic, data, archived, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, 0, ?, ?, ?) RETURNING id',
    kind, v.course, v.topic, JSON.stringify(v.data), now, now, by || null);
  await clearPracticeCache();
  return { id: Number(r.id) };
}
export async function updatePractice(id, b, by) {
  const cur = await one('SELECT * FROM practice_questions WHERE id = ?', Number(id));
  if (!cur) throw new PracticeError('NOT_FOUND', 'Question not found.', 404);
  const v = cur.kind === 'mcq' ? checkMcq(b) : checkCode(b);
  await run('UPDATE practice_questions SET course = ?, topic = ?, data = ?, draft = 0, updated_at = ?, updated_by = ? WHERE id = ?', v.course, v.topic, JSON.stringify(v.data), Date.now(), by || null, cur.id);
  await clearPracticeCache();
}
export async function setArchived(id, archived) {
  const r = await one('UPDATE practice_questions SET archived = ?, updated_at = ? WHERE id = ? RETURNING id', archived ? 1 : 0, Date.now(), Number(id));
  if (!r) throw new PracticeError('NOT_FOUND', 'Question not found.', 404);
  await clearPracticeCache();
}

// ---------- import from content JSON files (practice-import.js)
// dry: only report what would happen. drafts: also bring in incomplete questions as hidden drafts.
export async function importPractice(files, { dry = true, drafts = true } = {}, by) {
  const r = parseImport(files);
  const usable = r.items.filter((i) => !i.skip && i.course && i.topic && PRACTICE_COURSES[i.course]);
  const existing = new Map((await all("SELECT id, src_id, archived FROM practice_questions WHERE src_id IS NOT NULL AND src_id <> ''")).map((x) => [x.src_id, x]));
  const plan = usable.map((i) => {
    let complete = !i.issues.length;
    if (complete) { try { (i.kind === 'mcq' ? checkMcq : checkCode)({ ...i.data, course: i.course, topic: i.topic }); } catch (e) { complete = false; i.issues.push(e.message.replace(/\.$/, '').toLowerCase()); } }
    const ex = i.srcId ? existing.get(i.srcId) : null;
    const entry = { ...i, complete, action: ex ? 'update' : complete || drafts ? 'add' : 'skip', id: ex ? Number(ex.id) : null };
    i._p = entry;
    return entry;
  });
  const out = {
    summary: { ...r.summary, add: plan.filter((p) => p.action === 'add').length, update: plan.filter((p) => p.action === 'update').length },
    problems: r.problems,
    items: r.items.map((i) => { const p = i._p || null;
      return { file: i.file, kind: i.kind, course: i.course, topic: i.topic, type: i.type, title: i.kind === 'code' ? i.data.title : String(i.data.q || '').slice(0, 160),
        status: i.skip ? 'skipped' : !i.course || !i.topic ? 'skipped' : p && p.complete ? 'ready' : 'draft', why: i.skip || (i.issues || []).join(', '), action: p ? p.action : 'skip' }; })
  };
  if (dry) return out;
  const now = Date.now();
  for (const p of plan) {
    if (p.action === 'skip') continue;
    const data = { ...p.data, srcId: p.srcId, issues: p.complete ? [] : p.issues };
    if (p.action === 'update') await run('UPDATE practice_questions SET course = ?, topic = ?, data = ?, draft = ?, updated_at = ?, updated_by = ? WHERE id = ?', p.course, p.topic, JSON.stringify(data), p.complete ? 0 : 1, now, by || null, p.id);
    else await run('INSERT INTO practice_questions (kind, course, topic, data, archived, draft, src_id, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)',
      p.kind, p.course, p.topic, JSON.stringify(data), p.complete ? 0 : 1, p.srcId || null, now, now, by || null);
  }
  await clearPracticeCache();
  return { ...out, imported: true };
}
