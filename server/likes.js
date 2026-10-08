// Likes on the Watch videos ("reels"): one like per student per topic (unit). Counts per topic and per course
// are shown to students on the video and to admins in Admin → Video likes.
import { all, run } from './db.js';
import * as kv from './kv.js';
import { packUnits, unitRegistry } from './media.js';

const COUNTS = 'likes:counts:v1';
export const likeCounts = () => kv.cached(COUNTS, 30, async () => {
  const out = {};
  for (const r of await all('SELECT unit_id, COUNT(*) AS n FROM unit_likes GROUP BY unit_id')) out[r.unit_id] = Number(r.n);
  return out;
}, { localMs: 10000 });
export const myLikes = async (roll) => (await all('SELECT unit_id FROM unit_likes WHERE roll_no = ?', roll)).map((r) => r.unit_id);

export async function setLike(roll, unitId, liked) {
  const u = (packUnits().units || []).find((x) => x.id === unitId);
  if (!u) return null;
  if (liked) await run('INSERT INTO unit_likes (roll_no, unit_id, course, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (roll_no, unit_id) DO NOTHING', roll, unitId, u.course, Date.now());
  else await run('DELETE FROM unit_likes WHERE roll_no = ? AND unit_id = ?', roll, unitId);
  await kv.invalidate(COUNTS);
  const n = (await all('SELECT COUNT(*) AS n FROM unit_likes WHERE unit_id = ?', unitId))[0];
  return { liked: !!liked, count: Number(n.n) };
}

// Admin: likes per topic (with how many students opened the topic, for a like rate) and per course.
export async function likesAnalytics() {
  const [likes, opened] = await Promise.all([
    all(`SELECT l.unit_id, COUNT(*) AS n, MAX(l.created_at) AS last FROM unit_likes l
         JOIN students_master m ON m.roll_no = l.roll_no WHERE m.batch IS DISTINCT FROM 'TEST' GROUP BY l.unit_id`),
    all("SELECT unit_id, COUNT(DISTINCT roll_no) AS n FROM unit_events WHERE kind IN ('start', 'watch') GROUP BY unit_id")
  ]);
  const L = new Map(likes.map((r) => [r.unit_id, r])), O = new Map(opened.map((r) => [r.unit_id, Number(r.n)]));
  const topics = unitRegistry().map((u) => {
    const l = L.get(u.id), n = l ? Number(l.n) : 0, o = O.get(u.id) || 0;
    return { id: u.id, title: u.title, course: u.course, courseName: u.courseName, removed: u.removed, likes: n, opened: o,
      rate: o ? Math.round((n / o) * 1000) / 10 : null, lastAt: l ? Number(l.last) : null };
  });
  const byCourse = {};
  for (const t of topics) {
    const c = (byCourse[t.course] = byCourse[t.course] || { course: t.course, courseName: t.courseName, likes: 0, topics: 0, opened: 0 });
    c.likes += t.likes; c.topics += 1; c.opened += t.opened;
  }
  return { topics, courses: Object.values(byCourse), total: topics.reduce((s, t) => s + t.likes, 0) };
}
