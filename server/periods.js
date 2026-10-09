// Analytics per Sprint (the Sprint filter on the admin analytics pages):
//   Sprint 1 = before Fri 9 Oct 2026 00:00 IST, Sprint 2 = from then.
// Dated data (activity, logins, sessions, likes, flags, feedback) is split by time. Practice answers and finished steps
// carry no date, so they are split by content: Sprint 1 = the built-in topics and question bank, Sprint 2 = the topics
// added in Admin → Courses & topics and the practice questions of those topics.
// Sprint 1 counts every student who was in the list then (also those deactivated later); Sprint 2 the active list.
import { unitRegistry } from './media.js';

export const SPRINT2_START = Date.parse('2026-10-09T00:00:00+05:30');
const PERIODS = {
  s1: { id: 's1', label: 'Sprint 1', from: 0, to: SPRINT2_START, fromDay: '0000-01-01', toDay: '2026-10-09',
    students: `m.batch IS DISTINCT FROM 'TEST' AND (m.created_at IS NULL OR m.created_at < ${SPRINT2_START})` },
  s2: { id: 's2', label: 'Sprint 2', from: SPRINT2_START, to: 8.64e15, fromDay: '2026-10-09', toDay: '9999-12-31',
    students: "m.active = 1 AND m.batch IS DISTINCT FROM 'TEST'" }
};
export const periodOf = (p) => PERIODS[p] || null;
export const PERIOD_LIST = Object.values(PERIODS).map((p) => ({ id: p.id, label: p.label }));

// Topics added in Admin → Courses & topics have ids "u-…" (media.js addUnit); the built-in ones do not.
export const isSprint2Unit = (u) => String((u && u.id) || u || '').startsWith('u-');
export const unitInPeriod = (period, u) => !period || (period.id === 's2') === isSprint2Unit(u);

// Practice topics of Sprint 2: the added topics' names and Practice topics, compared like the portal does
// (portal-bridge.js ssPracticeFollowsLearn): "Type Conversions | Part 1" matches "Type Conversion".
const key = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/\binro\b|\bintroduction\b/g, 'intro')
  .replace(/\bpart\s*-?\s*\d+\b/g, '').replace(/[^a-z0-9]+/g, '').replace(/s$/, '');
export function topicInPeriod(period, topic) {
  if (!period) return true;
  const s2 = new Set();
  for (const u of unitRegistry()) if (isSprint2Unit(u)) { s2.add(key(u.title)); if (u.practiceTopic) s2.add(key(u.practiceTopic)); }
  return (period.id === 's2') === s2.has(key(topic));
}
