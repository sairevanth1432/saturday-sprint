// Analytics per Sprint (the Sprint filter on the admin analytics pages):
//   Sprint 1 = before Fri 9 Oct 2026 00:00 IST, Sprint 2 = 9 Oct up to Thu 15 Oct 00:00 IST, Sprint 3 = from then.
// Dated data (activity, logins, sessions, likes, flags, feedback) is split by time. Practice answers and finished steps
// carry no date, so they are split by content: Sprint 1 = the built-in topics and question bank; Sprint 2 and 3 = the
// topics added in Admin → Courses & topics (by when the topic was added) and the practice questions of those topics.
// Students: Sprint 1 = everyone listed before 9 Oct (also those deactivated later); Sprint 2 = everyone listed before
// 15 Oct who was still active then (also those deactivated by the Sprint 3 list); Sprint 3 = the active list.
import { unitRegistry, unitCreatedAt } from './media.js';

export const SPRINT2_START = Date.parse('2026-10-09T00:00:00+05:30');
export const SPRINT3_START = Date.parse('2026-10-15T00:00:00+05:30');
const NOT_TEST = "m.batch IS DISTINCT FROM 'TEST'";
const PERIODS = {
  s1: { id: 's1', label: 'Sprint 1', from: 0, to: SPRINT2_START, fromDay: '0000-01-01', toDay: '2026-10-09',
    students: `${NOT_TEST} AND (m.created_at IS NULL OR m.created_at < ${SPRINT2_START})` },
  s2: { id: 's2', label: 'Sprint 2', from: SPRINT2_START, to: SPRINT3_START, fromDay: '2026-10-09', toDay: '2026-10-15',
    students: `${NOT_TEST} AND (m.created_at IS NULL OR m.created_at < ${SPRINT3_START}) AND (m.active = 1 OR m.updated_at >= ${SPRINT3_START})` },
  s3: { id: 's3', label: 'Sprint 3', from: SPRINT3_START, to: 8.64e15, fromDay: '2026-10-15', toDay: '9999-12-31',
    students: `m.active = 1 AND ${NOT_TEST}` }
};
export const LATEST_PERIOD = 's3';
export const periodOf = (p) => PERIODS[p] || null;
export const PERIOD_LIST = Object.values(PERIODS).map((p) => ({ id: p.id, label: p.label }));
export const allPeriods = () => Object.values(PERIODS);

// Topics added in Admin → Courses & topics have ids "u-…" (media.js addUnit); the built-in ones do not.
export const isSprint2Unit = (u) => String((u && u.id) || u || '').startsWith('u-');
// Which Sprint a topic belongs to: built-in → s1; added before 12 Oct → s2; added from then → s3. Topics are added in
// the days before their Sprint starts (the Sprint 3 topics on 14 Oct), so the cut-off is SPRINT3_START minus a lead time.
const UNIT_LEAD_MS = 3 * 864e5;
export function unitSprint(u) {
  const id = String((u && u.id) || u || '');
  if (!id.startsWith('u-')) return 's1';
  const at = unitCreatedAt(id);
  return at && at >= SPRINT3_START - UNIT_LEAD_MS ? 's3' : 's2';
}
export const unitInPeriod = (period, u) => !period || unitSprint(u) === period.id;

// Practice topics of the added Sprints: the added topics' names and Practice topics, compared like the portal does
// (portal-bridge.js ssPracticeFollowsLearn): "Type Conversions | Part 1" matches "Type Conversion".
const key = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/\binro\b|\bintroduction\b/g, 'intro')
  .replace(/\bpart\s*-?\s*\d+\b/g, '').replace(/[^a-z0-9]+/g, '').replace(/s$/, '');
export function topicInPeriod(period, topic) {
  if (!period) return true;
  const added = new Map(); // topic key → s2 / s3 (a later Sprint wins when both used the same name)
  for (const u of unitRegistry()) {
    if (!isSprint2Unit(u)) continue;
    const sp = unitSprint(u);
    for (const k of [key(u.title), u.practiceTopic ? key(u.practiceTopic) : '']) if (k && (!added.has(k) || sp > added.get(k))) added.set(k, sp);
  }
  return (added.get(key(topic)) || 's1') === period.id;
}
