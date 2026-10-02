// Sprint questions managed in Admin → Sprint questions (one set per Sprint ID), and the student review after
// the test. Answers are stored by question position, so a set is locked once a student has started that Sprint.
import { one, all, run, tx, getSetting, setSetting, parseJSON } from './db.js';
import { getSprint, getQuestions, builtinQuestions, clearQuestionCache, rowToQuestion, resultView, SprintError, MARKS } from './sprint.js';
import { packUnits } from './media.js';

const COURSES = { pf: 'Programming Foundations', genai: 'Intro to GenAI' };
export const unitsList = () => (packUnits().units || []).map((u) => ({ id: u.id || (u.lessons && u.lessons[0] && u.lessons[0].id), course: u.course, title: u.name || u.title || '' }));
const SPRINT_ID = /^[A-Za-z0-9_.-]{3,60}$/;
function checkSprintId(id) {
  id = String(id || '').trim();
  if (!SPRINT_ID.test(id)) throw new SprintError('BAD_SPRINT', 'Unknown Sprint ID.', 400);
  return id;
}

export const studentAttempts = async (sprintId) =>
  Number((await one("SELECT COUNT(*) AS n FROM attempts WHERE sprint_id = ? AND roll_no NOT LIKE 'ADMIN-%'", sprintId)).n);
async function assertUnlocked(sprintId) {
  const n = await studentAttempts(sprintId);
  if (n) throw new SprintError('LOCKED', `${n} student${n === 1 ? ' has' : 's have'} already started this Sprint, so its questions can no longer change (answers are stored by question number). Use a new Sprint ID for a new set.`, 409);
}
const rowsOf = (sprintId) => all('SELECT * FROM sprint_questions WHERE sprint_id = ? ORDER BY position, id', sprintId);

// Sprints an admin can pick: the current one, plus any with questions or attempts.
export async function listSprints() {
  const cur = await getSprint();
  const rows = await all(`SELECT sprint_id, SUM(q) AS questions, SUM(a) AS attempts FROM (
      SELECT sprint_id, 1 AS q, 0 AS a FROM sprint_questions
      UNION ALL SELECT sprint_id, 0 AS q, 1 AS a FROM attempts WHERE roll_no NOT LIKE 'ADMIN-%') x GROUP BY sprint_id`);
  const list = rows.map((r) => ({ id: r.sprint_id, questions: Number(r.questions), attempts: Number(r.attempts), current: r.sprint_id === cur.id }));
  if (!list.some((s) => s.current)) list.push({ id: cur.id, questions: 0, attempts: 0, current: true });
  return list.sort((a, b) => (b.current - a.current) || a.id.localeCompare(b.id));
}

export async function listQuestions(rawId) {
  const sprintId = checkSprintId(rawId);
  const [rows, attempts] = await Promise.all([rowsOf(sprintId), studentAttempts(sprintId)]);
  const custom = rows.length > 0;
  const questions = custom ? rows.map(rowToQuestion) : builtinQuestions().map((q) => ({ ...q, unit: q.unit || '' }));
  return { sprintId, source: custom ? 'custom' : 'builtin', locked: attempts > 0, attempts, units: unitsList(), courses: COURSES,
    questions, maxTotal: questions.reduce((s, q) => s + (MARKS[q.type] || 1), 0) };
}

function clean(b) {
  b = b || {};
  const q = String(b.q || '').trim(), code = String(b.code || '').replace(/\s+$/, '');
  const options = (Array.isArray(b.options) ? b.options : []).map((o) => String(o == null ? '' : o).trim());
  const correct = Number(b.correct), course = String(b.course || '');
  const unit = String(b.unit || '');
  if (!q || q.length > 2000) throw new SprintError('BAD_QUESTION', 'Write the question (up to 2,000 characters).', 400);
  if (code.length > 5000) throw new SprintError('BAD_QUESTION', 'The code snippet is too long (up to 5,000 characters).', 400);
  if (options.length < 2 || options.length > 6) throw new SprintError('BAD_QUESTION', 'Give 2 to 6 options.', 400);
  if (options.some((o) => !o || o.length > 500)) throw new SprintError('BAD_QUESTION', 'Every option needs text (up to 500 characters).', 400);
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw new SprintError('BAD_QUESTION', 'Two options are the same.', 400);
  if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) throw new SprintError('BAD_QUESTION', 'Choose the correct option.', 400);
  if (!COURSES[course]) throw new SprintError('BAD_QUESTION', 'Choose the course.', 400);
  if (unit && !unitsList().some((u) => u.id === unit && u.course === course)) throw new SprintError('BAD_QUESTION', 'That unit is not part of the chosen course.', 400);
  return { q, code, options, correct, course, unit };
}

export async function addQuestion(rawId, body, by) {
  const sprintId = checkSprintId(rawId), c = clean(body), now = Date.now();
  await assertUnlocked(sprintId);
  // The first question added to a Sprint replaces the built-in set for it (the console warns before that).
  const pos = Number((await one('SELECT COALESCE(MAX(position), 0) AS p FROM sprint_questions WHERE sprint_id = ?', sprintId)).p) + 1;
  const r = await one(`INSERT INTO sprint_questions (sprint_id, position, course, unit_id, q, code, options, correct, created_at, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`, sprintId, pos, c.course, c.unit, c.q, c.code, JSON.stringify(c.options), c.correct, now, now, by || null);
  clearQuestionCache(sprintId);
  return rowToQuestion(r);
}

export async function updateQuestion(rawId, qid, body, by) {
  const sprintId = checkSprintId(rawId), c = clean(body);
  await assertUnlocked(sprintId);
  const r = await one(`UPDATE sprint_questions SET course = ?, unit_id = ?, q = ?, code = ?, options = ?, correct = ?, updated_at = ?, updated_by = ?
    WHERE id = ? AND sprint_id = ? RETURNING *`, c.course, c.unit, c.q, c.code, JSON.stringify(c.options), c.correct, Date.now(), by || null, Number(qid), sprintId);
  if (!r) throw new SprintError('NOT_FOUND', 'Question not found.', 404);
  clearQuestionCache(sprintId);
  return rowToQuestion(r);
}

async function renumber(sprintId) {
  const rows = await rowsOf(sprintId);
  for (const [i, r] of rows.entries()) if (Number(r.position) !== i + 1) await run('UPDATE sprint_questions SET position = ? WHERE id = ?', i + 1, r.id);
}
export async function deleteQuestion(rawId, qid) {
  const sprintId = checkSprintId(rawId);
  await assertUnlocked(sprintId);
  const r = await one('DELETE FROM sprint_questions WHERE id = ? AND sprint_id = ? RETURNING *', Number(qid), sprintId);
  if (!r) throw new SprintError('NOT_FOUND', 'Question not found.', 404);
  await renumber(sprintId);
  clearQuestionCache(sprintId);
  return rowToQuestion(r);
}

export async function reorderQuestions(rawId, ids) {
  const sprintId = checkSprintId(rawId);
  await assertUnlocked(sprintId);
  const rows = await rowsOf(sprintId), want = (Array.isArray(ids) ? ids : []).map(Number);
  const have = rows.map((r) => Number(r.id));
  if (want.length !== have.length || new Set(want).size !== want.length || !want.every((id) => have.includes(id))) {
    throw new SprintError('BAD_ORDER', 'The list of questions changed. Reload and try again.', 409);
  }
  await tx(async () => { for (const [i, id] of want.entries()) await run('UPDATE sprint_questions SET position = ? WHERE id = ?', i + 1, id); });
  clearQuestionCache(sprintId);
}

// Fill an empty Sprint from the built-in set or another Sprint's questions.
export async function copyQuestions(rawId, from, by) {
  const sprintId = checkSprintId(rawId);
  await assertUnlocked(sprintId);
  if ((await rowsOf(sprintId)).length) throw new SprintError('NOT_EMPTY', 'This Sprint already has questions. Delete them first, or copy into a new Sprint ID.', 409);
  let src;
  if (from === 'builtin') src = builtinQuestions().filter((q) => q.type === 'mcq').map((q) => ({ ...q, unit: q.unit || '' }));
  else {
    const fromId = checkSprintId(from);
    if (fromId === sprintId) throw new SprintError('BAD_SPRINT', 'Choose a different Sprint to copy from.', 400);
    src = (await rowsOf(fromId)).map(rowToQuestion);
    if (!src.length) throw new SprintError('EMPTY', 'That Sprint has no questions of its own.', 400);
  }
  const now = Date.now();
  await tx(async () => {
    for (const [i, q] of src.entries()) {
      await run(`INSERT INTO sprint_questions (sprint_id, position, course, unit_id, q, code, options, correct, created_at, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, sprintId, i + 1, q.course, q.unit || '', q.q, q.code || '', JSON.stringify(q.o), q.c, now, now, by || null);
    }
  });
  clearQuestionCache(sprintId);
  return src.length;
}

// ---------- review after the test
export const REVIEW_MODES = ['hidden', 'after_close', 'after_submit'];
export async function reviewMode(sprintId) {
  const m = await getSetting('review_mode:' + sprintId, 'after_close');
  return REVIEW_MODES.includes(m) ? m : 'after_close';
}
export async function setReviewMode(sprintId, mode) {
  if (!REVIEW_MODES.includes(mode)) throw new SprintError('BAD_SETTING', 'Unknown review setting.', 400);
  await setSetting('review_mode:' + sprintId, mode);
}

export async function reviewFor(who, rawSprint) {
  const cur = await getSprint();
  const sprintId = rawSprint ? checkSprintId(rawSprint) : cur.id;
  const key = who.kind === 'admin' ? 'ADMIN-' + who.id : who.roll_no;
  const a = await one('SELECT * FROM attempts WHERE sprint_id = ? AND roll_no = ?', sprintId, key);
  const sprint = { id: sprintId, title: sprintId === cur.id ? cur.title : sprintId, closeMs: sprintId === cur.id ? cur.closeMs : null };
  if (!a) return { open: false, reason: 'not_taken', sprint };
  if (a.status !== 'submitted') return { open: false, reason: 'not_submitted', sprint };
  const mode = await reviewMode(sprintId), now = Date.now();
  const closed = sprintId !== cur.id || now >= cur.closeMs; // a past Sprint is over
  const open = who.kind === 'admin' || mode === 'after_submit' || (mode === 'after_close' && closed);
  const result = resultView(a);
  if (!open) return { open: false, reason: mode === 'hidden' ? 'hidden' : 'before_close', mode, sprint, result };

  const qs = await getQuestions(sprintId), answers = parseJSON(a.answers, {}) || {};
  const units = Object.fromEntries(unitsList().map((u) => [u.id, u]));
  const items = qs.map((q, i) => {
    const pick = answers.mcq && answers.mcq[i] !== undefined ? answers.mcq[i] : null;
    const u = q.unit && units[q.unit];
    return { n: i + 1, type: q.type, course: q.course, courseTitle: COURSES[q.course] || q.course, unit: q.unit || '', unitTitle: u ? u.title : '',
      q: q.q, code: q.code || '', o: q.o || [], correct: q.type === 'mcq' ? q.c : null, pick, right: q.type === 'mcq' && pick === q.c };
  });
  // Score per unit (questions without a unit are grouped under their course)
  const groups = new Map();
  for (const it of items) {
    if (it.type !== 'mcq') continue;
    const k = it.unit || 'course:' + it.course;
    const g = groups.get(k) || { unit: it.unit, course: it.course, title: it.unitTitle || it.courseTitle + (it.unit ? '' : ' (other questions)'), right: 0, of: 0 };
    g.of++; if (it.right) g.right++;
    groups.set(k, g);
  }
  const order = unitsList().map((u) => u.id);
  const byUnit = [...groups.values()].sort((x, y) => (order.indexOf(x.unit) + 1 || 99) - (order.indexOf(y.unit) + 1 || 99));
  const byCourse = Object.keys(COURSES).map((c) => {
    const its = items.filter((it) => it.course === c && it.type === 'mcq');
    return { course: c, title: COURSES[c], right: its.filter((it) => it.right).length, of: its.length };
  }).filter((c) => c.of);
  return { open: true, mode, sprint, result, items, byUnit, byCourse };
}
