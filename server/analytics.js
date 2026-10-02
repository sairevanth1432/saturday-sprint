// Student analytics (super admin): active time and clicks per student, unit, step and day, logins, practice,
// and the Sprint. The portal sends activity in batches (POST /api/activity); rows are summed per IST day.
import { one, all, run, getSetting, parseJSON } from './db.js';
import * as kv from './kv.js';
import { getSprint, getQuestions } from './sprint.js';
import { packUnits } from './media.js';
import { practiceCatalogue } from './practice.js';

export const AREAS = ['home', 'learn', 'practice', 'code', 'test', 'board'];
const AREA_SET = new Set(AREAS);
const STEP_SET = new Set(['', 'watch', 'play', 'read']);
const MAX_ROW_MS = 5 * 60000, MAX_BATCH_MS = 15 * 60000;

// IST calendar day for a timestamp
export const istDay = (ms) => new Date(ms + 5.5 * 3600000).toISOString().slice(0, 10);

const COURSE_TITLES = { pf: 'Programming Foundations', genai: 'Intro to GenAI' };
const SESSION_ID = /^[a-z0-9-]{6,40}$/;

// body: { session: { id, startedAt }, items: [{ area, item, step, ms, opens, videoMs, videoPct, firstAt }] }
export async function recordActivity(who, body) {
  if (who.kind !== 'student') return { ok: true, ignored: true }; // admin previews are not counted
  const now = Date.now(), day = istDay(now);
  let budget = MAX_BATCH_MS, n = 0, batchMs = 0;
  const unitIds = new Set(unitList().map((u) => u.id));
  for (const r of (Array.isArray(body && body.items) ? body.items : []).slice(0, 40)) {
    if (!r || !AREA_SET.has(r.area)) continue;
    const item = String(r.item || '').slice(0, 80), step = STEP_SET.has(r.step) ? r.step : '';
    const ms = Math.min(MAX_ROW_MS, budget, Math.max(0, Math.round(Number(r.ms) || 0)));
    budget -= ms;
    const opens = Math.min(50, Math.max(0, Math.round(Number(r.opens) || 0)));
    const videoMs = Math.min(MAX_ROW_MS, Math.max(0, Math.round(Number(r.videoMs) || 0)));
    const videoPct = Math.min(100, Math.max(0, Math.round(Number(r.videoPct) || 0)));
    if (!ms && !opens && !videoMs && !videoPct) continue;
    batchMs += ms;
    // first time this student opened the unit (the browser's time, kept within the last 15 minutes)
    if (r.area === 'learn' && unitIds.has(item)) {
      const firstAt = Math.min(now, Math.max(now - 15 * 60000, Number(r.firstAt) || now));
      await run('INSERT INTO unit_events (roll_no, unit_id, kind, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', who.roll_no, item, 'start', firstAt);
    }
    await run(`INSERT INTO activity (roll_no, day, area, item, step, ms, opens, video_ms, video_pct, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (roll_no, day, area, item, step) DO UPDATE SET ms = activity.ms + excluded.ms, opens = activity.opens + excluded.opens,
        video_ms = activity.video_ms + excluded.video_ms, video_pct = GREATEST(activity.video_pct, excluded.video_pct), updated_at = excluded.updated_at`,
      who.roll_no, day, r.area, item, step, ms, opens, videoMs, videoPct, now);
    n++;
  }
  // the visit this report belongs to (sessions/user, average session duration)
  const sid = body && body.session && String(body.session.id || '');
  if (sid && SESSION_ID.test(sid)) {
    const startedAt = Math.min(now, Math.max(now - 12 * 3600000, Number(body.session.startedAt) || now));
    await run(`INSERT INTO activity_sessions (session_id, roll_no, started_at, last_at, active_ms) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET last_at = excluded.last_at, active_ms = activity_sessions.active_ms + excluded.active_ms`,
      who.roll_no + ':' + sid, who.roll_no, startedAt, now, batchMs);
  }
  return { ok: true, saved: n };
}

// ---------- helpers
// Each unit is one lesson; its id is the lesson id (the one the portal reports activity under).
const unitList = () => (packUnits().units || []).map((u) => ({ id: u.id || (u.lessons && u.lessons[0] && u.lessons[0].id), course: u.course, title: u.name || u.title || u.id, practiceTopic: u.practiceTopic || '' }));
// The portal stores finished steps by position ("pf-0-0:watch" = course pf, unit 1, lesson 1); map them to unit ids.
export function stepsDoneByUnit(progressData) {
  const d = parseJSON(progressData, {}) || {}, sd = d.stepDone || {}, out = {};
  const byCourse = {};
  for (const u of unitList()) (byCourse[u.course] = byCourse[u.course] || []).push(u);
  for (const k of Object.keys(sd)) {
    if (!sd[k]) continue;
    const m = /^([a-z]+)-(\d+)-(\d+):(watch|play|read)$/.exec(k);
    if (!m) continue;
    const u = (byCourse[m[1]] || [])[Number(m[2])];
    if (u) (out[u.id] = out[u.id] || new Set()).add(m[4]);
  }
  return out;
}
// Real students only: TEST-batch accounts (scripts/test-accounts.js, seed-test) are never counted in analytics.
const STUDENTS_WHERE = "m.active = 1 AND m.batch <> 'TEST'";
function sinceDay(days) { return istDay(Date.now() - (Math.max(1, days) - 1) * 86400000); }

// ---------- overview: the whole cohort
export async function overview({ days = 30 } = {}) {
  const from = sinceDay(days), today = istDay(Date.now());
  const J = `FROM activity a JOIN students_master m ON m.roll_no = a.roll_no WHERE ${STUDENTS_WHERE} AND a.day >= ?`;
  const [daily, areas, units, totals, cohort, logins, today7] = await Promise.all([
    all(`SELECT a.day, COUNT(DISTINCT a.roll_no) AS students, SUM(a.ms) AS ms ${J} GROUP BY a.day ORDER BY a.day`, from),
    all(`SELECT a.area, SUM(a.ms) AS ms, SUM(a.opens) AS opens, COUNT(DISTINCT a.roll_no) AS students ${J} GROUP BY a.area`, from),
    all(`SELECT a.item, a.step, SUM(a.ms) AS ms, SUM(a.opens) AS opens, COUNT(DISTINCT a.roll_no) AS students, SUM(a.video_ms) AS video_ms,
           AVG(NULLIF(a.video_pct, 0)) AS video_pct ${J} AND a.area = 'learn' GROUP BY a.item, a.step`, from),
    one(`SELECT COUNT(DISTINCT a.roll_no) AS students, SUM(a.ms) AS ms ${J}`, from),
    one(`SELECT COUNT(*) AS n FROM students_master m WHERE ${STUDENTS_WHERE}`),
    one(`SELECT COUNT(*) AS n, COUNT(DISTINCT l.roll_no) AS students FROM student_logins l JOIN students_master m ON m.roll_no = l.roll_no WHERE ${STUDENTS_WHERE} AND l.at >= ?`,
      Date.parse(from + 'T00:00:00+05:30')),
    one(`SELECT COUNT(DISTINCT a.roll_no) AS students ${J} AND a.day = ?`, from, today)
  ]);
  // units: one row per unit with its three steps
  const per = {};
  for (const r of units) {
    const u = per[r.item] = per[r.item] || { ms: 0, opens: 0, students: new Set(), steps: {} };
    u.ms += Number(r.ms) || 0; u.opens += Number(r.opens) || 0;
    u.steps[r.step || 'watch'] = { ms: Number(r.ms) || 0, opens: Number(r.opens) || 0, students: Number(r.students) || 0, videoMs: Number(r.video_ms) || 0, videoPct: r.video_pct == null ? null : Math.round(Number(r.video_pct)) };
  }
  const studentsPerUnit = await all(`SELECT a.item, COUNT(DISTINCT a.roll_no) AS students ${J} AND a.area = 'learn' GROUP BY a.item`, from);
  const spu = Object.fromEntries(studentsPerUnit.map((r) => [r.item, Number(r.students)]));
  // finished steps per unit, from saved progress
  const prog = await all(`SELECT pr.data FROM progress pr JOIN students_master m ON m.roll_no = pr.roll_no WHERE ${STUDENTS_WHERE}`);
  const done = {};
  for (const p of prog) for (const [uid, set] of Object.entries(stepsDoneByUnit(p.data))) {
    done[uid] = done[uid] || { watch: 0, play: 0, read: 0, all3: 0 };
    for (const s of set) done[uid][s]++;
    if (set.has('watch') && set.has('play') && set.has('read')) done[uid].all3++;
  }
  return {
    days, from, today, cohort: Number(cohort.n),
    totals: { students: Number(totals.students) || 0, ms: Number(totals.ms) || 0, logins: Number(logins.n) || 0, loginStudents: Number(logins.students) || 0, activeToday: Number(today7.students) || 0 },
    daily: daily.map((r) => ({ day: r.day, students: Number(r.students), ms: Number(r.ms) })),
    areas: AREAS.map((a) => { const r = areas.find((x) => x.area === a) || {}; return { area: a, ms: Number(r.ms) || 0, opens: Number(r.opens) || 0, students: Number(r.students) || 0 }; }),
    units: unitList().map((u) => ({ ...u, ms: per[u.id] ? per[u.id].ms : 0, opens: per[u.id] ? per[u.id].opens : 0, students: spu[u.id] || 0,
      steps: (per[u.id] || {}).steps || {}, done: done[u.id] || { watch: 0, play: 0, read: 0, all3: 0 } }))
  };
}

// ---------- one row per student
export async function studentRows({ q = '', days = 30, sort = 'time', limit = 500, offset = 0 } = {}) {
  const from = sinceDay(days), fromMs = Date.parse(from + 'T00:00:00+05:30');
  const where = [STUDENTS_WHERE], p = [];
  if (q) { where.push('(m.roll_no ILIKE ? OR m.name ILIKE ? OR m.batch ILIKE ?)'); const l = '%' + q + '%'; p.push(l, l, l); }
  const ORDER = { time: 'ms DESC NULLS LAST', recent: 'last_active DESC NULLS LAST', least: 'ms ASC NULLS FIRST', name: 'm.name ASC', id: 'm.roll_no ASC' }[sort] || 'ms DESC NULLS LAST';
  const sql = `FROM students_master m LEFT JOIN users u ON u.roll_no = m.roll_no
    LEFT JOIN (SELECT roll_no, SUM(ms) AS ms, COUNT(DISTINCT day) AS days_active, MAX(updated_at) AS last_active,
                      SUM(CASE WHEN area = 'learn' THEN ms ELSE 0 END) AS learn_ms, SUM(CASE WHEN area = 'practice' OR area = 'code' THEN ms ELSE 0 END) AS practice_ms,
                      COUNT(DISTINCT CASE WHEN area = 'learn' THEN item END) AS units_opened, SUM(CASE WHEN area = 'learn' THEN opens ELSE 0 END) AS unit_clicks,
                      SUM(video_ms) AS video_ms
               FROM activity WHERE day >= ? GROUP BY roll_no) a ON a.roll_no = m.roll_no
    LEFT JOIN (SELECT roll_no, COUNT(*) AS logins, MAX(at) AS last_login FROM student_logins WHERE at >= ? GROUP BY roll_no) l ON l.roll_no = m.roll_no
    LEFT JOIN progress pr ON pr.roll_no = m.roll_no
    WHERE ${where.join(' AND ')}`;
  const [cnt, rows] = await Promise.all([
    one('SELECT COUNT(*) AS n ' + sql, from, fromMs, ...p),
    all(`SELECT m.roll_no, m.name, m.batch, u.id AS user_id, u.last_login_at, a.ms, a.days_active, a.last_active, a.learn_ms, a.practice_ms, a.units_opened, a.unit_clicks,
           a.video_ms, l.logins, pr.data AS progress ${sql} ORDER BY ${ORDER}, m.roll_no LIMIT ? OFFSET ?`, from, fromMs, ...p, Math.min(5000, limit), offset)
  ]);
  const cat = practiceCatalogue(), byGi = new Map(cat.quiz.map((x) => [x.gi, x]));
  const units = unitList().length;
  return {
    total: Number(cnt.n), days, from, units,
    rows: rows.map((r) => {
      const d = parseJSON(r.progress, {}) || {};
      let answered = 0, correct = 0;
      for (const [gi, k] of Object.entries(d.pPick || {})) { const qq = byGi.get(Number(gi)); if (!qq || k == null) continue; answered++; if (sameAnswer(qq, k)) correct++; }
      const done = stepsDoneByUnit(r.progress);
      return {
        roll_no: r.roll_no, name: r.name, batch: r.batch, registered: !!r.user_id, last_login_at: r.last_login_at,
        ms: Number(r.ms) || 0, days_active: Number(r.days_active) || 0, last_active: r.last_active ? Number(r.last_active) : null,
        learn_ms: Number(r.learn_ms) || 0, practice_ms: Number(r.practice_ms) || 0, video_ms: Number(r.video_ms) || 0,
        units_opened: Number(r.units_opened) || 0, unit_clicks: Number(r.unit_clicks) || 0, logins: Number(r.logins) || 0,
        units_completed: Object.values(done).filter((s) => s.size === 3).length, steps_done: Object.values(done).reduce((n, s) => n + s.size, 0),
        practice_answered: answered, practice_correct: correct, coding_solved: Object.keys(d.solved || {}).filter((k) => d.solved[k] && cat.code.some((c) => c.id === k)).length
      };
    })
  };
}
const sameAnswer = (q, k) => (Array.isArray(q.c) ? Array.isArray(k) && k.length === q.c.length && q.c.every((x) => k.includes(x)) : k === q.c);

// ---------- one student in detail
export async function studentDetail(roll, { days = 30 } = {}) {
  const m = await one('SELECT roll_no, name, batch, email, active FROM students_master WHERE roll_no = ?', roll);
  if (!m) return null;
  const from = sinceDay(days);
  const [u, act, logins, pr, attempts] = await Promise.all([
    one('SELECT created_at, last_login_at, status FROM users WHERE roll_no = ?', roll),
    all('SELECT day, area, item, step, ms, opens, video_ms, video_pct FROM activity WHERE roll_no = ? AND day >= ? ORDER BY day', roll, from),
    all('SELECT at, method, ip, ua FROM student_logins WHERE roll_no = ? ORDER BY at DESC LIMIT 50', roll),
    one('SELECT data, updated_at FROM progress WHERE roll_no = ?', roll),
    all('SELECT id, sprint_id, status, started_at, submitted_at, total, max_total, used_ms, violations FROM attempts WHERE roll_no = ? ORDER BY started_at DESC', roll)
  ]);
  const done = stepsDoneByUnit(pr && pr.data);
  const units = unitList().map((x) => {
    const rows = act.filter((a) => a.area === 'learn' && a.item === x.id), step = (s) => rows.filter((a) => (a.step || 'watch') === s);
    const sum = (rs, k) => rs.reduce((n, a) => n + (Number(a[k]) || 0), 0);
    return { ...x, opens: sum(rows, 'opens'), ms: sum(rows, 'ms'),
      steps: Object.fromEntries(['watch', 'play', 'read'].map((s) => [s, { ms: sum(step(s), 'ms'), opens: sum(step(s), 'opens'), done: !!(done[x.id] && done[x.id].has(s)),
        videoMs: s === 'watch' ? sum(step(s), 'video_ms') : 0, videoPct: s === 'watch' ? Math.max(0, ...step(s).map((a) => Number(a.video_pct) || 0)) : 0 }])) };
  });
  const dayMap = {};
  for (const a of act) { const d = dayMap[a.day] = dayMap[a.day] || { day: a.day, ms: 0, areas: {} }; d.ms += Number(a.ms) || 0; d.areas[a.area] = (d.areas[a.area] || 0) + (Number(a.ms) || 0); }
  const areas = AREAS.map((ar) => ({ area: ar, ms: act.filter((a) => a.area === ar).reduce((n, a) => n + (Number(a.ms) || 0), 0), opens: act.filter((a) => a.area === ar).reduce((n, a) => n + (Number(a.opens) || 0), 0) }));
  // practice per topic
  const cat = practiceCatalogue(), d = parseJSON(pr && pr.data, {}) || {}, topics = {};
  for (const qq of cat.quiz) {
    const t = topics[qq.course + '|' + qq.sess] = topics[qq.course + '|' + qq.sess] || { course: qq.course, sess: qq.sess, total: 0, answered: 0, correct: 0, ms: 0 };
    t.total++;
    const k = (d.pPick || {})[qq.gi];
    if (k != null) { t.answered++; if (sameAnswer(qq, k)) t.correct++; }
  }
  for (const a of act) if (a.area === 'practice') { const t = Object.values(topics).find((x) => x.sess === a.item); if (t) t.ms += Number(a.ms) || 0; }
  return { student: m, account: u, days, from, units, daily: Object.values(dayMap), areas, logins, practice: Object.values(topics), attempts,
    totals: { ms: act.reduce((n, a) => n + (Number(a.ms) || 0), 0), days: Object.keys(dayMap).length, logins: logins.length } };
}

// =====================================================================================================================
// Business metrics (Reach → Activity → Learning → Practice → Assessment → Retention → Completion) and the unit table.
// Every value is computed from recorded rows only. A metric that cannot be computed yet is { value: null, reason }.
// TEST-batch students are never counted. Nothing here writes to student data.
// =====================================================================================================================
const DAY = 86400000;
const dayAdd = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const median = (xs) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fmtDay = (d) => (d ? new Date(Date.parse(d + 'T00:00:00Z')).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const durTxt = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? Math.round(ms / 1000) + 's' : m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };
const fmtTs = (t) => (t ? fmtDay(istDay(Number(t))) : '');
// one metric: value (null = not available), unit (count | pct | ms | ratio | perUser), definition, basis, reason
const M = (label, value, unit, def, basis, reason) => ({ label, value: value == null || Number.isNaN(value) ? null : value, unit, def, basis: basis || '', reason: value == null ? (reason || 'No data yet.') : '' });

// Record when a step became finished (✓ in the portal), comparing the saved progress with the new one.
// Only reads the old progress; the progress itself is stored by the caller exactly as sent.
export async function recordStepEvents(roll, oldData, newData) {
  const oldDone = (parseJSON(oldData, {}) || {}).stepDone || {}, nowDone = (newData && newData.stepDone) || {};
  const fresh = Object.keys(nowDone).filter((k) => nowDone[k] && !oldDone[k]);
  if (!fresh.length) return 0;
  const byUnit = stepsDoneByUnit(JSON.stringify({ stepDone: Object.fromEntries(fresh.map((k) => [k, true])) }));
  const at = Date.now();
  let n = 0;
  for (const [unit, steps] of Object.entries(byUnit)) {
    for (const s of steps) { await run('INSERT INTO unit_events (roll_no, unit_id, kind, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', roll, unit, s, at); n++; }
  }
  return n;
}

export async function businessMetrics({ sprintId, fresh = false } = {}) {
  if (fresh) await kv.invalidate('bm:v1:' + (sprintId || '')).catch(() => {});
  return kv.cached('bm:v1:' + (sprintId || ''), 60, () => computeBusiness(sprintId), { localMs: 60000 });
}

async function computeBusiness(sprintIdParam) {
  const now = Date.now(), today = istDay(now);
  const units = unitList(), unitIds = units.map((u) => u.id);
  const J = (t) => `JOIN students_master m ON m.roll_no = ${t}.roll_no WHERE ${STUDENTS_WHERE}`;
  const cur = await getSprint();
  const sprintId = sprintIdParam || cur.id;
  const [cohortRows, progRows, dayRows, areaRows, learnRows, sessRows, evRows, firstAct, firstSess, firstEv, passMark, attRows, sprintList, questions] = await Promise.all([
    all(`SELECT m.roll_no, u.id AS user_id FROM students_master m LEFT JOIN users u ON u.roll_no = m.roll_no WHERE ${STUDENTS_WHERE}`),
    all(`SELECT pr.roll_no, pr.data FROM progress pr ${J('pr')}`),
    all(`SELECT a.roll_no, a.day FROM activity a ${J('a')} GROUP BY a.roll_no, a.day`),
    all(`SELECT a.roll_no, a.area, SUM(a.ms) AS ms FROM activity a ${J('a')} GROUP BY a.roll_no, a.area`),
    all(`SELECT a.roll_no, a.item, a.step, SUM(a.ms) AS ms, SUM(a.opens) AS opens, SUM(a.video_ms) AS video_ms, MAX(a.video_pct) AS video_pct
         FROM activity a ${J('a')} AND a.area = 'learn' GROUP BY a.roll_no, a.item, a.step`),
    all(`SELECT s.roll_no, s.active_ms FROM activity_sessions s ${J('s')} AND s.started_at >= ?`, now - 30 * DAY),
    all(`SELECT e.roll_no, e.unit_id, e.kind, e.at FROM unit_events e ${J('e')}`),
    one('SELECT MIN(day) AS d FROM activity'),
    one('SELECT MIN(started_at) AS t FROM activity_sessions'),
    one('SELECT MIN(at) AS t FROM unit_events'),
    getSetting('pass_mark_pct', 40),
    all(`SELECT a.roll_no, a.status, a.total, a.max_total, a.answers, a.text_reviewed FROM attempts a ${J('a')} AND a.sprint_id = ? AND a.roll_no NOT LIKE 'ADMIN-%'`, sprintId),
    all(`SELECT a.sprint_id, COUNT(*) AS n FROM attempts a ${J('a')} AND a.roll_no NOT LIKE 'ADMIN-%' GROUP BY a.sprint_id`),
    getQuestions(sprintId)
  ]);

  // ---- per-student facts
  const cohort = cohortRows.length;
  const registered = new Set(cohortRows.filter((r) => r.user_id != null).map((r) => r.roll_no));
  const cat = practiceCatalogue(), quizByGi = new Map(cat.quiz.map((q) => [q.gi, q])), codeIds = new Set(cat.code.map((c) => c.id));
  const P = new Map(); // roll → { done: {unit:Set}, answers: [{q, right}], solves }
  for (const r of progRows) {
    const d = parseJSON(r.data, {}) || {};
    const answers = [];
    for (const [gi, k] of Object.entries(d.pPick || {})) { const q = quizByGi.get(Number(gi)); if (q && k != null) answers.push({ q, right: sameAnswer(q, k) }); }
    const solves = Object.keys(d.solved || {}).filter((k) => d.solved[k] && codeIds.has(k)).length;
    P.set(r.roll_no, { done: stepsDoneByUnit(r.data), answers, solves });
  }
  const days = new Map();
  for (const r of dayRows) (days.get(r.roll_no) || days.set(r.roll_no, new Set()).get(r.roll_no)).add(r.day);
  const studyMs = new Map();
  for (const r of areaRows) if (['learn', 'practice', 'code'].includes(r.area)) studyMs.set(r.roll_no, (studyMs.get(r.roll_no) || 0) + Number(r.ms || 0));
  const L = new Map(); // `${roll}|${unit}` → { watch:{ms,opens,videoMs,videoPct}, play, read }
  for (const r of learnRows) {
    if (!unitIds.includes(r.item)) continue;
    const k = r.roll_no + '|' + r.item, o = L.get(k) || L.set(k, {}).get(k);
    o[r.step || 'watch'] = { ms: Number(r.ms || 0), opens: Number(r.opens || 0), videoMs: Number(r.video_ms || 0), videoPct: Number(r.video_pct || 0) };
  }
  const EV = new Map(); // `${roll}|${unit}` → { start, watch, play, read } timestamps
  for (const e of evRows) { const k = e.roll_no + '|' + e.unit_id, o = EV.get(k) || EV.set(k, {}).get(k); o[e.kind] = Number(e.at); }
  const rolls = new Set([...registered]);
  const doneOf = (roll, unit) => ((P.get(roll) || {}).done || {})[unit] || new Set();
  const started = (roll, unit) => {
    const l = L.get(roll + '|' + unit);
    return !!(l && Object.values(l).some((s) => s.ms > 0 || s.opens > 0)) || doneOf(roll, unit).size > 0 || !!(EV.get(roll + '|' + unit) || {}).start;
  };
  const activated = new Set([...rolls].filter((r) => {
    const p = P.get(r);
    return (studyMs.get(r) || 0) > 0 || unitIds.some((u) => started(r, u)) || (p && (p.answers.length || p.solves));
  }));
  const actSince = firstAct && firstAct.d, sessSince = firstSess && firstSess.t ? Number(firstSess.t) : null, evSince = firstEv && firstEv.t ? Number(firstEv.t) : null;
  const sinceTxt = actSince ? 'activity data since ' + fmtDay(actSince) : '';
  const noAct = 'No portal activity has been recorded for students yet.';

  // ---- Reach
  const reach = [
    M('Students in the list', cohort, 'count', 'Active students in Master data (TEST batch excluded).', ''),
    M('Registered users', registered.size, 'count', 'Students from the list who have an account (logged in at least once).', pct(registered.size, cohort) == null ? '' : pct(registered.size, cohort) + '% of the list'),
    M('Activated users', activated.size, 'count', 'Registered students who started learning: opened a unit, finished a step, spent time in Learn/Practice/Code, answered a practice question or solved a coding problem.', registered.size ? pct(activated.size, registered.size) + '% of registered' : '')
  ];

  // ---- Activity
  const activeIn = (from, to) => [...days.entries()].filter(([, ds]) => [...ds].some((d) => d >= from && d <= to)).length;
  const span = actSince ? dayDiff(actSince, today) + 1 : 0;
  const win = (n) => Math.max(1, Math.min(n, span));
  let activity;
  if (!actSince || !days.size) activity = ['DAU', 'WAU', 'MAU', 'DAU/MAU'].map((l) => M(l, null, 'count', '', '', noAct));
  else {
    const dau = activeIn(today, today), wau = activeIn(dayAdd(today, -(win(7) - 1)), today), mau = activeIn(dayAdd(today, -(win(30) - 1)), today);
    let sumDau = 0; for (let i = 0; i < win(30); i++) { const d = dayAdd(today, -i); sumDau += activeIn(d, d); }
    const avgDau = sumDau / win(30);
    const lab = (n) => (win(n) < n ? `last ${win(n)} day${win(n) === 1 ? '' : 's'} (${sinceTxt})` : `last ${n} days`);
    activity = [
      M('DAU', dau, 'count', 'Students active today (IST): the portal open and in use.', 'today'),
      M('WAU', wau, 'count', 'Students active on at least one day in the last 7 days.', lab(7)),
      M('MAU', mau, 'count', 'Students active on at least one day in the last 30 days.', lab(30)),
      M('DAU/MAU', mau ? Math.round((avgDau / mau) * 1000) / 10 : null, 'pct', 'Average daily active students divided by MAU: how habitual the portal is (100% = every active student comes every day).', lab(30), 'No active students in the window.')
    ];
  }
  const sessUsers = new Set(sessRows.map((s) => s.roll_no));
  const sessReason = sessSince ? 'No student sessions in the last 30 days.' : 'Sessions are recorded from this release onward; none yet.';
  activity.push(
    M('Sessions/user', sessUsers.size ? Math.round((sessRows.length / sessUsers.size) * 10) / 10 : null, 'ratio', 'Visits per student in the last 30 days. A visit starts when the portal is opened and ends after 30 minutes without activity.', sessUsers.size ? `${sessRows.length} sessions · ${sessUsers.size} students · since ${fmtTs(sessSince)}` : '', sessReason),
    M('Avg. session duration', sessRows.length ? Math.round(sessRows.reduce((s, x) => s + Number(x.active_ms || 0), 0) / sessRows.length) : null, 'ms', 'Average active time per visit (time the portal was open and in use), last 30 days.', sessRows.length ? `${sessRows.length} sessions` : '', sessReason));

  // ---- Learning
  const learners = [...studyMs.entries()].filter(([r, ms]) => ms > 0 && rolls.has(r));
  const totalStudy = learners.reduce((s, [, ms]) => s + ms, 0);
  let starts = 0, finishedSteps = 0, completedUnits = 0;
  for (const r of rolls) for (const u of unitIds) {
    if (!started(r, u)) continue;
    starts++; const d = doneOf(r, u); finishedSteps += d.size; if (d.size === 3) completedUnits++;
  }
  const learning = [
    M('Learning hours/user', learners.length ? totalStudy / learners.length : null, 'ms', 'Active time in Learn, Practice and Write code, per student who spent any time there.', learners.length ? `${learners.length} students · total ${durTxt(totalStudy)} · ${sinceTxt}` : '', noAct),
    M('Content starts', starts, 'count', 'Units started (a student opened a unit, finished one of its steps, or spent time in it).', activated.size ? `${Math.round((starts / activated.size) * 10) / 10} per activated student` : ''),
    M('Content completion rate', pct(finishedSteps, starts * 3), 'pct', 'Finished steps (Watch, Play, Read: the ✓ in the portal) out of all steps of the units students started.', starts ? `${finishedSteps} of ${starts * 3} steps` : '', 'No unit started yet.'),
    M('Lesson completion rate', pct(completedUnits, starts), 'pct', 'Started units with all three steps finished.', starts ? `${completedUnits} of ${starts} started units` : '', 'No unit started yet.')
  ];

  // ---- Practice
  let answered = 0, correct = 0, solves = 0, answerers = 0;
  const practisers = new Set();
  for (const r of rolls) { const p = P.get(r); if (!p) continue; answered += p.answers.length; correct += p.answers.filter((a) => a.right).length; solves += p.solves; if (p.answers.length) answerers++; if (p.answers.length || p.solves) practisers.add(r); }
  const practice = [
    M('Practice attempts/user', practisers.size ? Math.round(((answered + solves) / practisers.size) * 10) / 10 : null, 'ratio', 'Practice questions answered plus coding problems solved, per student who practised.', practisers.size ? `${practisers.size} students practised` : '', 'No practice yet.'),
    M('Questions attempted', answered, 'count', 'Practice quiz questions answered (each student\'s first answer to each question).', answered ? `accuracy ${pct(correct, answered)}%` : ''),
    M('Practice completion rate', pct(answered, answerers * cat.quiz.length), 'pct', `Questions answered out of all ${cat.quiz.length} practice questions, per student who answered any.`, answerers ? `${answerers} students` : '', 'No practice questions answered yet.'),
    M('Re-attempt rate', null, 'pct', 'Students answering a question again to improve.', '', 'Not measurable: the portal keeps each student\'s first answer and does not allow re-attempts.')
  ];

  // ---- Assessment
  const startedA = attRows.length, sub = attRows.filter((a) => a.status === 'submitted');
  const scorePct = sub.filter((a) => Number(a.max_total) > 0).map((a) => (Number(a.total) / Number(a.max_total)) * 100);
  const pm = Number(passMark);
  const pending = sub.filter((a) => !a.text_reviewed).length;
  const aReason = `No student has started Sprint "${sprintId}" yet.`;
  const assessment = [
    M('Assessment attempts', startedA, 'count', `Students who started the Sprint test "${sprintId}".`, registered.size ? pct(startedA, registered.size) + '% of registered' : ''),
    M('Submission rate', pct(sub.length, startedA), 'pct', 'Started attempts that were submitted (by the student, or automatically when time ran out).', startedA ? `${sub.length} of ${startedA}` : '', aReason),
    M('Avg. score', scorePct.length ? Math.round((scorePct.reduce((s, x) => s + x, 0) / scorePct.length) * 10) / 10 : null, 'pct', 'Average score as a % of the total marks, over submitted attempts.', scorePct.length ? `${scorePct.length} submitted${pending ? ' · ' + pending + ' still need written marks' : ''}` : '', startedA ? 'No attempt submitted yet.' : aReason),
    M('Pass rate', Number.isFinite(pm) && pm > 0 && scorePct.length ? pct(scorePct.filter((x) => x >= pm).length, scorePct.length) : null, 'pct', `Submitted attempts scoring at least the pass mark (${pm}% of total marks; Sprint settings).`, scorePct.length ? `${scorePct.filter((x) => x >= pm).length} of ${scorePct.length} passed` : '', !Number.isFinite(pm) || pm <= 0 ? 'Set a pass mark in Sprint settings.' : startedA ? 'No attempt submitted yet.' : aReason)
  ];

  // ---- Retention (first day = a student's first active day since tracking began)
  const first = new Map([...days.entries()].map(([r, ds]) => [r, [...ds].sort()[0]]));
  const dN = (n) => {
    const elig = [...first.entries()].filter(([, f]) => dayDiff(f, today) >= n);
    if (!elig.length) return M(`D${n} retention`, null, 'pct', '', '', actSince ? `Needs students whose first active day was at least ${n} day${n === 1 ? '' : 's'} ago (${sinceTxt}).` : noAct);
    const kept = elig.filter(([r, f]) => days.get(r).has(dayAdd(f, n))).length;
    return M(`D${n} retention`, pct(kept, elig.length), 'pct', `Students active again exactly ${n} day${n === 1 ? '' : 's'} after their first active day.`, `${kept} of ${elig.length} students`);
  };
  const retention = [dN(1), dN(7), dN(30)];
  if (!actSince || span < 14) retention.push(M('Weekly retention', null, 'pct', '', '', actSince ? `Needs 14 days of activity data (${sinceTxt}).` : noAct));
  else {
    const prev = [...days.entries()].filter(([, ds]) => [...ds].some((d) => d >= dayAdd(today, -13) && d <= dayAdd(today, -7)));
    const kept = prev.filter(([, ds]) => [...ds].some((d) => d >= dayAdd(today, -6))).length;
    retention.push(M('Weekly retention', pct(kept, prev.length), 'pct', 'Students active 7–13 days ago who were also active in the last 7 days.', `${kept} of ${prev.length} students`, 'Nobody was active 7–13 days ago.'));
  }
  const withAct = [...days.entries()];
  const inactive = (n) => withAct.filter(([, ds]) => [...ds].sort().pop() <= dayAdd(today, -n)).length;
  retention.push(M('Inactive 7+ days', withAct.length ? inactive(7) : null, 'count', 'Students with portal activity whose last active day was 7 or more days ago.', withAct.length ? `${pct(inactive(7), withAct.length)}% of ${withAct.length} students with activity · inactive 14+ days: ${inactive(14)}` : '', noAct));

  // ---- Completion
  const courses = [...new Set(units.map((u) => u.course))];
  const courseDone = (r, c) => units.filter((u) => u.course === c).every((u) => doneOf(r, u.id).size === 3);
  const completion = courses.map((c) => {
    const n = [...rolls].filter((r) => courseDone(r, c)).length;
    return M(`Course completion: ${COURSE_TITLES[c] || c}`, pct(n, registered.size), 'pct', `Registered students who finished all three steps of every ${COURSE_TITLES[c] || c} unit.`, registered.size ? `${n} students · ${pct(n, activated.size) ?? 0}% of activated` : '', 'No registered students yet.');
  });
  const modShares = [...activated].map((r) => units.filter((u) => doneOf(r, u.id).size === 3).length / units.length);
  completion.push(M('Module completion', modShares.length ? Math.round((modShares.reduce((s, x) => s + x, 0) / modShares.length) * 1000) / 10 : null, 'pct', `Average share of the ${units.length} units completed (all three steps), per activated student.`, modShares.length ? `${modShares.length} activated students` : '', 'No activated students yet.'));
  const ttcOf = (r, u) => { const e = EV.get(r + '|' + u); if (!e || !e.start || !e.watch || !e.play || !e.read) return null; const d = Math.max(e.watch, e.play, e.read) - e.start; return d >= 0 ? d : null; };
  const allTtc = [];
  for (const r of rolls) for (const u of unitIds) { const d = ttcOf(r, u); if (d != null) allTtc.push(d); }
  const evReason = evSince ? `Measured for units started and finished since ${fmtTs(evSince)}; none yet.` : 'Unit start and finish times are recorded from this release onward; none yet.';
  completion.push(M('Time to completion (unit)', median(allTtc), 'ms', 'Median time from opening a unit to finishing its last step.', allTtc.length ? `${allTtc.length} completed units · since ${fmtTs(evSince)}` : '', evReason));
  const courseTtc = [];
  for (const r of rolls) for (const c of courses) {
    const us = units.filter((u) => u.course === c).map((u) => EV.get(r + '|' + u.id) || {});
    if (!us.every((e) => e.start && e.watch && e.play && e.read)) continue;
    courseTtc.push(Math.max(...us.map((e) => Math.max(e.watch, e.play, e.read))) - Math.min(...us.map((e) => e.start)));
  }
  completion.push(M('Time to completion (course)', median(courseTtc), 'ms', 'Median time from opening the first unit of a course to finishing its last step.', courseTtc.length ? `${courseTtc.length} completed courses · since ${fmtTs(evSince)}` : '', evReason));

  // ---- Units
  const sprintSubs = sub.map((a) => parseJSON(a.answers, {}) || {});
  const qStats = questions.map((q, i) => {
    const picks = sprintSubs.map((ans) => (ans.mcq || {})[i]).filter((v) => v !== undefined && v !== null);
    const right = q.type === 'mcq' ? sprintSubs.filter((ans) => (ans.mcq || {})[i] === q.c).length : null;
    return { n: i + 1, unit: q.unit || '', course: q.course, q: q.q, type: q.type, answered: picks.length, right, correctPct: q.type === 'mcq' ? pct(right, sprintSubs.length) : null };
  });
  const topics = new Set(cat.quiz.map((q) => q.sess));
  const unitRowsOut = units.map((u) => {
    const starters = [...rolls].filter((r) => started(r, u.id));
    const stepDone = (s) => starters.filter((r) => doneOf(r, u.id).has(s)).length;
    const completed = starters.filter((r) => doneOf(r, u.id).size === 3).length;
    const stepTime = (s) => {
      const xs = starters.map((r) => (L.get(r + '|' + u.id) || {})[s]).filter((x) => x && x.ms > 0);
      return { avgMs: xs.length ? Math.round(xs.reduce((a, x) => a + x.ms, 0) / xs.length) : null, students: xs.length };
    };
    const vids = starters.map((r) => (L.get(r + '|' + u.id) || {}).watch).filter((x) => x && (x.videoMs > 0 || x.videoPct > 0));
    const topic = u.practiceTopic || (topics.has(u.title) ? u.title : '');
    let practiceOut = null;
    if (topic) {
      const tq = cat.quiz.filter((q) => q.sess === topic);
      const per = [...rolls].map((r) => (P.get(r) || { answers: [] }).answers.filter((a) => a.q.sess === topic)).filter((a) => a.length);
      const ans = per.reduce((s, a) => s + a.length, 0), ok = per.reduce((s, a) => s + a.filter((x) => x.right).length, 0);
      practiceOut = { topic, questions: tq.length, students: per.length, avgAnsweredPct: per.length ? Math.round((per.reduce((s, a) => s + a.length / tq.length, 0) / per.length) * 1000) / 10 : null, accuracy: pct(ok, ans), answers: ans };
    }
    const uq = qStats.filter((q) => q.unit === u.id && q.type === 'mcq');
    const uRight = uq.reduce((s, q) => s + q.right, 0);
    const ttc = starters.map((r) => ttcOf(r, u.id)).filter((x) => x != null);
    return {
      id: u.id, title: u.title, course: u.course, courseTitle: COURSE_TITLES[u.course] || u.course,
      started: starters.length, startedPct: pct(starters.length, activated.size),
      done: { watch: stepDone('watch'), play: stepDone('play'), read: stepDone('read') }, completed, completionRate: pct(completed, starters.length),
      time: { watch: stepTime('watch'), play: stepTime('play'), read: stepTime('read') },
      video: { students: vids.length, avgPct: vids.length ? Math.round(vids.reduce((s, x) => s + x.videoPct, 0) / vids.length) : null, avgMs: vids.length ? Math.round(vids.reduce((s, x) => s + x.videoMs, 0) / vids.length) : null },
      practice: practiceOut,
      assessment: { questions: uq.length, submitted: sprintSubs.length, correctPct: uq.length && sprintSubs.length ? pct(uRight, uq.length * sprintSubs.length) : null, items: uq },
      ttc: { medianMs: median(ttc), n: ttc.length }
    };
  });
  const untagged = courses.map((c) => {
    const uq = qStats.filter((q) => !q.unit && q.course === c && q.type === 'mcq');
    return { course: c, courseTitle: COURSE_TITLES[c] || c, questions: uq.length, correctPct: uq.length && sprintSubs.length ? pct(uq.reduce((s, q) => s + q.right, 0), uq.length * sprintSubs.length) : null, items: uq };
  }).filter((x) => x.questions);

  return {
    at: now, today, since: { activity: actSince, sessions: sessSince, unitEvents: evSince },
    sprint: { id: sprintId, current: sprintId === cur.id, list: sprintList.map((s) => ({ id: s.sprint_id, attempts: Number(s.n) })), passMark: pm },
    funnel: [
      { key: 'reach', title: 'Reach', metrics: reach }, { key: 'activity', title: 'Activity', metrics: activity },
      { key: 'learning', title: 'Learning', metrics: learning }, { key: 'practice', title: 'Practice', metrics: practice },
      { key: 'assessment', title: 'Assessment', metrics: assessment }, { key: 'retention', title: 'Retention', metrics: retention },
      { key: 'completion', title: 'Completion', metrics: completion }
    ],
    units: unitRowsOut, untagged
  };
}
