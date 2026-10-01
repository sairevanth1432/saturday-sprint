// Student analytics (super admin): active time and clicks per student, unit, step and day, logins, practice,
// and the Sprint. The portal sends activity in batches (POST /api/activity); rows are summed per IST day.
import { config } from './config.js';
import { one, all, run, parseJSON } from './db.js';
import { packUnits } from './media.js';
import { practiceCatalogue } from './practice.js';

export const AREAS = ['home', 'learn', 'practice', 'code', 'test', 'board'];
const AREA_SET = new Set(AREAS);
const STEP_SET = new Set(['', 'watch', 'play', 'read']);
const MAX_ROW_MS = 5 * 60000, MAX_BATCH_MS = 15 * 60000;

// IST calendar day for a timestamp
export const istDay = (ms) => new Date(ms + 5.5 * 3600000).toISOString().slice(0, 10);

// body: { items: [{ area, item, step, ms, opens, videoMs, videoPct }] }
export async function recordActivity(who, body) {
  if (who.kind !== 'student') return { ok: true, ignored: true }; // admin previews are not counted
  const now = Date.now(), day = istDay(now);
  let budget = MAX_BATCH_MS, n = 0;
  for (const r of (Array.isArray(body && body.items) ? body.items : []).slice(0, 40)) {
    if (!r || !AREA_SET.has(r.area)) continue;
    const item = String(r.item || '').slice(0, 80), step = STEP_SET.has(r.step) ? r.step : '';
    const ms = Math.min(MAX_ROW_MS, budget, Math.max(0, Math.round(Number(r.ms) || 0)));
    budget -= ms;
    const opens = Math.min(50, Math.max(0, Math.round(Number(r.opens) || 0)));
    const videoMs = Math.min(MAX_ROW_MS, Math.max(0, Math.round(Number(r.videoMs) || 0)));
    const videoPct = Math.min(100, Math.max(0, Math.round(Number(r.videoPct) || 0)));
    if (!ms && !opens && !videoMs && !videoPct) continue;
    await run(`INSERT INTO activity (roll_no, day, area, item, step, ms, opens, video_ms, video_pct, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (roll_no, day, area, item, step) DO UPDATE SET ms = activity.ms + excluded.ms, opens = activity.opens + excluded.opens,
        video_ms = activity.video_ms + excluded.video_ms, video_pct = GREATEST(activity.video_pct, excluded.video_pct), updated_at = excluded.updated_at`,
      who.roll_no, day, r.area, item, step, ms, opens, videoMs, videoPct, now);
    n++;
  }
  return { ok: true, saved: n };
}

// ---------- helpers
// Each unit is one lesson; its id is the lesson id (the one the portal reports activity under).
const unitList = () => (packUnits().units || []).map((u) => ({ id: u.id || (u.lessons && u.lessons[0] && u.lessons[0].id), course: u.course, title: u.name || u.title || u.id }));
// The portal stores finished steps by position ("pf-0-0:watch" = course pf, unit 1, lesson 1); map them to unit ids.
function stepsDoneByUnit(progressData) {
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
const STUDENTS_WHERE = "m.active = 1" + (config.isLive ? " AND m.batch <> 'TEST'" : '');
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
