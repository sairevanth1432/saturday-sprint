// The student's race (portal Home "track", streak, badges): where they stand on the course, where the cohort stands,
// how many days in a row they have been active, and which medals they have earned. Read-only over existing data
// (progress, activity, unit_events, practice_submissions, attempts); nothing is stored.
import { one, all, parseJSON } from './db.js';
import * as kv from './kv.js';
import { config } from './config.js';
import { packUnits } from './media.js';
import { stepsDoneByUnit, istDay } from './analytics.js';
import { leaderboard, studentUniversity } from './sprint.js';

const STEPS = 3; // Watch → Play → Read
const unitIds = () => (packUnits().units || []).map((u) => u.id).filter(Boolean);
const doneSteps = (data, ids) => { const d = stepsDoneByUnit(data); return ids.reduce((n, id) => n + (d[id] ? d[id].size : 0), 0); };
const pctOf = (done, total) => (total ? Math.min(100, Math.round((done / total) * 100)) : 0);
// Real students only on the live site (test accounts never shape the cohort there); locally they make the track testable.
const COHORT = `m.active = 1${config.isLive ? " AND m.batch <> 'TEST'" : ''}`;

// Where everyone in the university stands: a share of students per 10% band of the course. Cached a minute.
async function cohort(university) {
  const key = 'journey:cohort:v1:' + (university == null ? '*' : university);
  return kv.cached(key, 60, async () => {
    const ids = unitIds(), total = ids.length * STEPS;
    const U = university == null ? '' : ' AND m.university = ?', args = university == null ? [] : [university];
    const [cnt, rows] = await Promise.all([
      one(`SELECT COUNT(*) AS n FROM students_master m WHERE ${COHORT}${U}`, ...args),
      all(`SELECT p.data FROM progress p JOIN students_master m ON m.roll_no = p.roll_no WHERE ${COHORT}${U}`, ...args)
    ]);
    const n = Number(cnt.n) || 0, bands = new Array(11).fill(0), pcts = [];
    for (const r of rows) { const p = pctOf(doneSteps(r.data, ids), total); pcts.push(p); bands[Math.min(10, Math.floor(p / 10))]++; }
    bands[0] += Math.max(0, n - rows.length); // students who never saved progress stand at the start line
    pcts.sort((a, b) => a - b);
    return { n, bands, pcts, finished: pcts.filter((p) => p >= 100).length };
  }, { localMs: 15000 });
}

// Days (IST) with real activity: time or clicks in the portal, a finished step, a coding submission, a Sprint attempt.
async function activeDays(roll) {
  const [act, ev, sub, att, prog] = await Promise.all([
    all('SELECT DISTINCT day FROM activity WHERE roll_no = ? AND (ms > 0 OR opens > 0)', roll),
    all('SELECT at FROM unit_events WHERE roll_no = ?', roll),
    all('SELECT created_at AS at FROM practice_submissions WHERE roll_no = ?', roll),
    all('SELECT started_at AS at, submitted_at AS at2 FROM attempts WHERE roll_no = ?', roll),
    one('SELECT updated_at AS at FROM progress WHERE roll_no = ?', roll)
  ]);
  const days = new Set(act.map((r) => r.day));
  for (const r of ev) days.add(istDay(Number(r.at)));
  for (const r of sub) days.add(istDay(Number(r.at)));
  for (const r of att) { days.add(istDay(Number(r.at))); if (r.at2) days.add(istDay(Number(r.at2))); }
  if (prog && prog.at) days.add(istDay(Number(prog.at)));
  return days;
}
function streakOf(days) {
  const today = istDay(Date.now()), dayMs = 86400000;
  const back = (d, k) => istDay(Date.parse(d + 'T12:00:00+05:30') - k * dayMs);
  // current run: counts back from today, or from yesterday when nothing happened yet today
  let start = days.has(today) ? today : back(today, 1), run = 0;
  while (days.has(back(start, run))) run++;
  // best run ever
  const sorted = [...days].sort();
  let best = 0, cur = 0, prev = null;
  for (const d of sorted) { cur = prev && back(d, 1) === prev ? cur + 1 : 1; best = Math.max(best, cur); prev = d; }
  return { days: run, today: days.has(today), best: Math.max(best, run) };
}

// desc: how to earn it, two or three words (shown on the Profile page under the medal).
export const BADGES = [
  { id: 'first-lap', name: 'First lap', desc: 'Finish one step' },
  { id: 'full-circuit', name: 'Full circuit', desc: 'Finish every unit' },
  { id: 'pace-keeper', name: 'Pace keeper', desc: 'Three days running' },
  { id: 'finisher', name: 'Finisher', desc: 'Submit a Sprint' },
  { id: 'podium', name: 'Podium', desc: 'Finish top three' },
  { id: 'hat-trick', name: 'Hat-trick', desc: 'Three Sprints done' }
];

export async function journey(who) {
  if (who.kind !== 'student') return demo();
  const roll = who.roll_no, ids = unitIds(), total = ids.length * STEPS;
  const university = await studentUniversity(roll);
  const [prog, co, days, attempts] = await Promise.all([
    one('SELECT data FROM progress WHERE roll_no = ?', roll),
    cohort(university || null),
    activeDays(roll),
    all("SELECT sprint_id, submitted_at FROM attempts WHERE roll_no = ? AND status = 'submitted' ORDER BY submitted_at", roll)
  ]);
  const done = prog ? doneSteps(prog.data, ids) : 0, pct = pctOf(done, total);
  const streak = streakOf(days);
  let podium = null;
  for (const a of attempts) {
    const b = await leaderboard(roll, 1, { sprintId: a.sprint_id, university: university || null }).catch(() => null);
    if (b && b.me && b.me.rank <= 3 && (podium == null || b.me.rank < podium)) podium = b.me.rank;
  }
  const earned = {
    'first-lap': done >= 1, 'full-circuit': total > 0 && done >= total, 'pace-keeper': streak.best >= 3,
    finisher: attempts.length >= 1, podium: podium != null, 'hat-trick': attempts.length >= 3
  };
  return {
    pct, done, total, units: ids.length,
    cohort: { n: co.n, bands: co.bands, finished: co.finished, ahead: co.pcts.filter((p) => p > pct).length, median: co.pcts.length ? co.pcts[Math.floor(co.pcts.length / 2)] : 0 },
    streak, sprints: attempts.length, podium,
    badges: BADGES.map((b) => ({ ...b, earned: !!earned[b.id] }))
  };
}

// Admin preview of the student portal: a filled-in example so the layout can be checked.
function demo() {
  const n = unitIds().length;
  return {
    pct: 50, done: Math.round(n * STEPS / 2), total: n * STEPS, units: n, preview: true,
    cohort: { n: 120, bands: [34, 18, 14, 11, 9, 8, 7, 6, 5, 4, 4], finished: 4, ahead: 30, median: 30 },
    streak: { days: 3, today: true, best: 5 }, sprints: 1, podium: null,
    badges: BADGES.map((b, i) => ({ ...b, earned: i < 3 || b.id === 'finisher' }))
  };
}
