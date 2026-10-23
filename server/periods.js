// Analytics per Sprint (the Sprint filter on the admin analytics pages):
//   Sprint 1 = before Fri 9 Oct 2026 00:00 IST, Sprint 2 = 9 Oct up to Thu 15 Oct 00:00 IST, Sprint 3 = 15 Oct up to
//   Thu 22 Oct 00:00 IST, Sprint 4 = 22 Oct to 29 Oct (up to Fri 30 Oct 00:00 IST), then one Sprint per week, Fri to Thu
//   (Sprint 5 = 30 Oct to 5 Nov, …), added automatically once it starts.
// Dated data (activity, logins, sessions, likes, flags, feedback) is split by time. Practice answers and finished steps
// carry no date, so they are split by content: Sprint 1 = the built-in topics and question bank; Sprint 2 and 3 = the
// topics added in Admin → Courses & topics (by when the topic was added) and the practice questions of those topics.
// Sprint 4 (the 24 Oct test) reuses the Sprint 3 topics, so its topic data is the Sprint 3 topics plus any added for it.
// Students: Sprint 1 = everyone listed before 9 Oct (also those deactivated later); Sprint 2 = everyone listed before
// 15 Oct who was still active then (also those deactivated by the Sprint 3 list); Sprint 3 = the same up to 22 Oct;
// the latest Sprint = the active list.
import { unitRegistry, unitCreatedAt } from './media.js';

export const SPRINT2_START = Date.parse('2026-10-09T00:00:00+05:30');
export const SPRINT3_START = Date.parse('2026-10-15T00:00:00+05:30');
export const SPRINT4_START = Date.parse('2026-10-22T00:00:00+05:30');
export const SPRINT4_END = Date.parse('2026-10-30T00:00:00+05:30');
export const WEEK_MS = 7 * 864e5;
const NOT_TEST = "m.batch IS DISTINCT FROM 'TEST'";
// Sprints with their own dates. From Sprint 5 on, a new Sprint starts every week (Fri 00:00 IST, so the Saturday test
// falls inside it) and is added to the Sprint dropdown by itself once it has started: no code change per Sprint.
// topics: whose added topics the Sprint's topic data covers (default: its own).
const FIXED = [
  { from: 0, to: SPRINT2_START, note: 'built-in topics and practice, students listed then' },
  { from: SPRINT2_START, to: SPRINT3_START, note: 'topics added for Sprint 2, students listed then' },
  { from: SPRINT3_START, to: SPRINT4_START, note: 'topics added for Sprint 3, students listed then' },
  { from: SPRINT4_START, to: SPRINT4_END, topics: ['s3', 's4'], note: 'the Sprint 3 topics (the 24 Oct test) and any added for Sprint 4' }
];
const istDay = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
const dm = (day) => `${Number(day.slice(8))} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(day.slice(5, 7)) - 1]}`;
export function periodsAt(now) {
  const spans = FIXED.map((f) => ({ ...f }));
  for (let t = SPRINT4_END; t <= now; t += WEEK_MS) spans.push({ from: t, to: t + WEEK_MS, note: 'topics added for this Sprint' });
  return spans.map((f, i) => {
    const id = 's' + (i + 1), next = spans[i + 1], last = !next;
    const fromDay = i ? istDay(f.from) : '0000-01-01', toDay = istDay(f.to);
    const range = i ? `${dm(fromDay)}–${dm(istDay(f.to - 1))}` : `before ${dm(toDay)}`;
    // students: Sprint 1 = everyone listed before Sprint 2; a past Sprint = listed before the next one and still active
    // then; the latest Sprint = the current list
    const students = i === 0 ? `${NOT_TEST} AND (m.created_at IS NULL OR m.created_at < ${spans[1].from})`
      : last ? `m.active = 1 AND ${NOT_TEST}`
      : `${NOT_TEST} AND (m.created_at IS NULL OR m.created_at < ${next.from}) AND (m.active = 1 OR m.updated_at >= ${next.from})`;
    return { id, n: i + 1, label: 'Sprint ' + (i + 1), range, from: f.from, to: f.to, fromDay, toDay, topics: f.topics, students,
      note: `${i ? range : 'Before ' + dm(toDay)}: ${f.note}${last && i ? ', the current student list' : ''}.` };
  });
}
let built = null;
const periods = () => {
  const now = Date.now();
  if (!built || now - built.at > 60000) built = { at: now, list: periodsAt(now), map: null };
  if (!built.map) built.map = Object.fromEntries(built.list.map((p) => [p.id, p]));
  return built;
};
export const allPeriods = () => periods().list;
export const periodOf = (p) => (p && Object.hasOwn(periods().map, p) ? periods().map[p] : null);
export const latestPeriod = () => allPeriods().at(-1);
// For the admin Sprint dropdown, newest first.
export const periodList = () => allPeriods().map((p) => ({ id: p.id, label: p.label, range: p.range, note: p.note })).reverse();
const sprintNo = (id) => Number(String(id).slice(1)) || 1;

// Topics added in Admin → Courses & topics have ids "u-…" (media.js addUnit); the built-in ones do not.
export const isSprint2Unit = (u) => String((u && u.id) || u || '').startsWith('u-');
// Which Sprint a topic belongs to: built-in → s1; an added topic → the latest Sprint from Sprint 3 on whose start minus a
// lead time is before the topic was added, else s2. Topics are added in the days before their Sprint starts (the Sprint 3
// topics on 14 Oct), so each cut-off is the start minus a lead time (Sprint 4: from 19 Oct).
const UNIT_LEAD_MS = 3 * 864e5;
export function unitSprint(u) {
  const id = String((u && u.id) || u || '');
  if (!id.startsWith('u-')) return 's1';
  const at = unitCreatedAt(id);
  if (at) for (const p of [...allPeriods()].reverse()) if (p.n >= 3 && at >= p.from - UNIT_LEAD_MS) return p.id;
  return 's2';
}
const hasTopicsOf = (period, sp) => (period.topics || [period.id]).includes(sp);
export const unitInPeriod = (period, u) => !period || hasTopicsOf(period, unitSprint(u));

// Practice topics of the added Sprints: the added topics' names and Practice topics, compared like the portal does
// (portal-bridge.js ssPracticeFollowsLearn): "Type Conversions | Part 1" matches "Type Conversion".
const key = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/\binro\b|\bintroduction\b/g, 'intro')
  .replace(/\bpart\s*-?\s*\d+\b/g, '').replace(/[^a-z0-9]+/g, '').replace(/s$/, '');
export function topicInPeriod(period, topic) {
  if (!period) return true;
  const added = new Map(); // topic key → Sprint id (a later Sprint wins when both used the same name)
  for (const u of unitRegistry()) {
    if (!isSprint2Unit(u)) continue;
    const sp = unitSprint(u);
    for (const k of [key(u.title), u.practiceTopic ? key(u.practiceTopic) : '']) if (k && (!added.has(k) || sprintNo(sp) > sprintNo(added.get(k)))) added.set(k, sp);
  }
  return hasTopicsOf(period, added.get(key(topic)) || 's1');
}
