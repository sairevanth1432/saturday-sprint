// Load report: how much load the portal and the Sprint actually took, from the data already recorded
// (Sprint attempts, portal visits, logins), and what that means for a larger roll-out. Read-only: it never writes.
//
//   $env:DATABASE_URL = "postgres://…-pooler…/neondb?sslmode=require"     (Neon → Connection string, pooled)
//   node scripts/load-report.js [--users 2000] [--days 14]
//   Remove-Item Env:DATABASE_URL
//
// Without DATABASE_URL it reads the local development database (data/pglite).
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const TARGET = Number(opt('users', 2000)), DAYS = Number(opt('days', 14));

// Requests per second one student sends (portal-bridge.js timers): the test autosaves every 15 s; the rest of the
// portal saves progress at most every 30 s (only when it changed) and reports activity every ~2 min.
const RPS_TEST = 1 / 15 + 1 / 60, RPS_PORTAL = 1 / 45 + 1 / 135;

let q, close;
if (process.env.DATABASE_URL) {
  const pg = (await import('pg')).default;
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('SET default_transaction_read_only = on');
  q = async (sql, p = []) => (await c.query(sql, p)).rows;
  close = () => c.end();
} else {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(path.resolve(process.env.DATA_DIR || 'data', 'pglite'));
  q = async (sql, p = []) => (await db.query(sql, p)).rows;
  close = () => db.close();
}

const IST = 5.5 * 3600000;
const fmt = (ms) => new Date(Number(ms) + IST).toISOString().replace('T', ' ').slice(0, 16) + ' IST';
const n = (x) => Number(x || 0).toLocaleString('en-IN');
const since = Date.now() - DAYS * 86400000;

// Highest number of intervals [start, end) open at the same moment, and when.
function peak(intervals) {
  const ev = [];
  for (const [s, e] of intervals) if (e > s) ev.push([Number(s), 1], [Number(e), -1]);
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, max = 0, at = null;
  for (const [t, d] of ev) { cur += d; if (cur > max) { max = cur; at = t; } }
  return { max, at };
}
const perMinutePeak = (times) => {
  const m = new Map();
  for (const t of times) { const k = Math.floor(Number(t) / 60000); m.set(k, (m.get(k) || 0) + 1); }
  let best = [0, null];
  for (const [k, v] of m) if (v > best[0]) best = [v, k * 60000];
  return best;
};

const out = [];
const line = (s = '') => out.push(s);

// ---------- students
const [st] = await q(`SELECT (SELECT COUNT(*) FROM students_master WHERE active = 1) AS listed,
  (SELECT COUNT(*) FROM users WHERE status = 'active') AS accounts,
  (SELECT COUNT(DISTINCT roll_no) FROM student_logins WHERE at > $1) AS logged_in,
  (SELECT COUNT(*) FROM student_photos) AS photos`, [since]);
line('STUDENTS');
line(`  listed (active): ${n(st.listed)}   accounts: ${n(st.accounts)}   logged in, last ${DAYS} days: ${n(st.logged_in)}   photos: ${n(st.photos)}`);

// ---------- Sprint tests
line('\nSPRINT TESTS (students only)');
const sprints = await q(`SELECT sprint_id, COUNT(*) AS n, MIN(started_at) AS first, MAX(started_at) AS last FROM attempts
  WHERE roll_no NOT LIKE 'ADMIN-%' GROUP BY sprint_id ORDER BY MIN(started_at)`);
let worstShare = 0;
for (const s of sprints) {
  const rows = await q(`SELECT started_at, COALESCE(submitted_at, deadline_at) AS ended FROM attempts WHERE sprint_id = $1 AND roll_no NOT LIKE 'ADMIN-%'`, [s.sprint_id]);
  const p = peak(rows.map((r) => [r.started_at, r.ended]));
  const [startsMin, startsAt] = perMinutePeak(rows.map((r) => r.started_at));
  const share = p.max / Number(s.n);
  worstShare = Math.max(worstShare, share);
  line(`  ${s.sprint_id}: ${n(s.n)} took it, ${fmt(s.first)} → ${fmt(s.last)}`);
  line(`      at the same time: ${n(p.max)} (${fmt(p.at)}) = ${(share * 100).toFixed(1)}% of takers · busiest minute: ${n(startsMin)} starts (${fmt(startsAt)})`);
  line(`      ≈ ${(p.max * RPS_TEST).toFixed(1)} requests/s at that moment`);
}
if (!sprints.length) line('  no attempts yet');

// ---------- portal visits
line(`\nPORTAL VISITS (last ${DAYS} days)`);
const visits = await q('SELECT started_at, last_at FROM activity_sessions WHERE started_at > $1', [since]);
// A visit's last report is up to ~2.5 min before it ended.
const pv = peak(visits.map((v) => [v.started_at, Number(v.last_at) + 150000]));
const daily = await q(`SELECT day, COUNT(DISTINCT roll_no) AS users, SUM(ms) / 3600000.0 AS hours, SUM(video_ms) / 3600000.0 AS video_hours
  FROM activity WHERE day >= $1 GROUP BY day ORDER BY day`, [new Date(since + IST).toISOString().slice(0, 10)]);
const busiestDay = daily.reduce((b, d) => (Number(d.users) > Number(b.users || 0) ? d : b), {});
line(`  visits: ${n(visits.length)} · most students on the portal at once: ${n(pv.max)} (${pv.at ? fmt(pv.at) : '-'}) ≈ ${(pv.max * RPS_PORTAL).toFixed(1)} requests/s`);
if (busiestDay.day) line(`  busiest day: ${busiestDay.day}, ${n(busiestDay.users)} students, ${Number(busiestDay.hours).toFixed(0)} active hours, ${Number(busiestDay.video_hours).toFixed(0)} video hours`);
for (const d of daily.slice(-7)) line(`    ${d.day}: ${n(d.users)} students · ${Number(d.hours).toFixed(1)} h on the portal · ${Number(d.video_hours).toFixed(1)} h video`);
const [lg] = await q('SELECT COUNT(*) AS n FROM student_logins WHERE at > $1', [since]);
const [lgMin, lgAt] = perMinutePeak((await q('SELECT at FROM student_logins WHERE at > $1', [since])).map((r) => r.at));
line(`  log-ins: ${n(lg.n)} · busiest minute: ${n(lgMin)} (${lgAt ? fmt(lgAt) : '-'})`);
const activeUsers = Number(st.logged_in) || 1;
const portalShare = pv.max / activeUsers;

// ---------- database
line('\nDATABASE');
const [size] = await q('SELECT pg_database_size(current_database()) AS b');
line(`  size: ${(Number(size.b) / 1048576).toFixed(0)} MB`);
const tables = await q(`SELECT relname AS t, pg_total_relation_size(relid) AS b, n_live_tup AS rows FROM pg_stat_user_tables ORDER BY 2 DESC LIMIT 8`);
for (const t of tables) line(`    ${t.t.padEnd(22)} ${(Number(t.b) / 1048576).toFixed(1).padStart(8)} MB  ${n(t.rows)} rows`);
const [conn] = await q(`SELECT current_setting('max_connections') AS max, (SELECT COUNT(*) FROM pg_stat_activity) AS now`);
line(`  connections: ${conn.now} open now, max ${conn.max}`);

// ---------- projection
const testShare = Math.max(worstShare, 0.05), visitShare = Math.max(portalShare, 0.05);
const testPeak = Math.ceil(TARGET * testShare), portalPeak = Math.ceil(TARGET * visitShare);
line(`\nPROJECTION FOR ${n(TARGET)} STUDENTS (same behaviour as above; each share at least 5%)`);
line(`  Sprint: ~${n(testPeak)} taking the test at once (${(testShare * 100).toFixed(1)}%) → ~${(testPeak * RPS_TEST).toFixed(0)} requests/s`);
line(`  Portal: ~${n(portalPeak)} on the portal at once (${(visitShare * 100).toFixed(1)}%) → ~${(portalPeak * RPS_PORTAL).toFixed(0)} requests/s`);
line(`  Worst case, all ${n(TARGET)} in the test together: ~${(TARGET * RPS_TEST).toFixed(0)} requests/s`);

console.log(out.join('\n'));
await close();
