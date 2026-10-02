// Sprint proctoring: the browser reports test activity (tab switches, leaving full screen, copy attempts…);
// the server stores it as a timeline per attempt, counts violations and, past the limit set in Sprint settings,
// submits the attempt automatically from the student's saved answers.
import { one, all, run, getSetting, parseJSON } from './db.js';
import { getAttempt, readDraft, cleanAnswers, finalizeAttempt, getQuestions, SprintError } from './sprint.js';
import * as kv from './kv.js';

// Counted as violations (each one shows the student a warning).
export const VIOLATIONS = {
  tab_hidden: 'Left the test tab or minimised the browser',
  window_blur: 'Switched to another window or app',
  fs_exit: 'Left full screen',
  multi_instance: 'Test open in another tab or device'
};
// Logged only (already blocked in the browser, or informational).
const LOGGED = new Set(['start', 'resume', 'tab_visible', 'fs_enter', 'fs_denied', 'fs_unsupported', 'copy', 'cut', 'paste', 'contextmenu',
  'print', 'key_blocked', 'select_blocked', 'drag_blocked', 'offline', 'online', 'resize', 'devtools', 'warning_ack', 'submit', 'hb']);
export const EVENT_TYPES = new Set([...Object.keys(VIOLATIONS), ...LOGGED]);
const MAX_EVENTS_PER_ATTEMPT = 3000;

export async function proctorSettings() {
  const [enabled, fullscreen, maxViolations, blockCopy] = await Promise.all([
    getSetting('proctor_enabled', true), getSetting('proctor_fullscreen', true),
    getSetting('proctor_max_violations', 3), getSetting('proctor_block_copy', true)
  ]);
  return { enabled: !!enabled, fullscreen: !!fullscreen, maxViolations: Math.max(0, Number(maxViolations) || 0), blockCopy: !!blockCopy };
}

const summary = (a) => parseJSON(a.proctor, null) || { counts: {}, instances: 0, multi: false };

// body: { instance, events: [{ type, at, detail }], answers? }
export async function recordEvents(who, body) {
  const b = body || {};
  const a = await getAttempt(who);
  if (!a) throw new SprintError('NOT_STARTED', 'You have not started the Sprint.', 409);
  const settings = await proctorSettings();
  if (a.status !== 'running') return { ok: true, status: a.status, violations: a.violations, max: settings.maxViolations };
  const instance = String(b.instance || '').slice(0, 40) || 'unknown';
  const now = Date.now();
  const list = (Array.isArray(b.events) ? b.events : []).slice(0, 50)
    .filter((e) => e && EVENT_TYPES.has(e.type))
    .map((e) => ({ type: e.type, at: Number.isFinite(Number(e.at)) ? Math.min(now, Math.max(a.started_at - 60000, Number(e.at))) : now,
      detail: e.detail == null ? null : String(typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail)).slice(0, 300) }));

  // Every open test page sends a heartbeat each minute. Two pages (tabs, browsers or devices) alive at the same
  // time → flagged. Last-seen times live in Redis so heartbeats never write to the database.
  const ik = 'pinst:' + a.id;
  let seen = await kv.get(ik).catch(() => null);
  seen = (typeof seen === 'string' ? parseJSON(seen, {}) : seen) || {};
  const others = Object.entries(seen).filter(([id, t]) => id !== instance && now - t < 150000).map((o) => o[0]);
  const isNew = !seen[instance];
  seen[instance] = now;
  if (Object.keys(seen).length > 20) seen = Object.fromEntries(Object.entries(seen).sort((x, y) => y[1] - x[1]).slice(0, 20));
  await kv.set(ik, seen, 6 * 3600).catch(() => {});
  if (isNew && others.length) list.push({ type: 'multi_instance', at: now, detail: 'also open in: ' + others.join(', ') });
  const real = list.filter((e) => e.type !== 'hb');
  if (!real.length) return { ok: true, status: 'running', violations: a.violations, max: settings.maxViolations };
  list.length = 0; list.push(...real);

  const s = summary(a);
  s.counts = s.counts || {};
  s.instances = Object.keys(seen).length;
  if (others.length) s.multi = true;

  const n = (await one('SELECT COUNT(*) AS n FROM attempt_events WHERE attempt_id = ?', a.id)).n;
  const keep = list.slice(0, Math.max(0, MAX_EVENTS_PER_ATTEMPT - n));
  for (const e of keep) {
    await run('INSERT INTO attempt_events (attempt_id, roll_no, type, at, instance, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      a.id, a.roll_no, e.type, e.at, instance, e.detail, now);
    s.counts[e.type] = (s.counts[e.type] || 0) + 1;
  }
  const added = list.filter((e) => VIOLATIONS[e.type]).length;
  s.lastAt = now;
  const row = await one('UPDATE attempts SET violations = violations + ?, proctor = ?, updated_at = ? WHERE id = ? RETURNING violations',
    settings.enabled ? added : 0, JSON.stringify(s), now, a.id);
  const violations = row ? row.violations : a.violations;

  // Over the limit: submit now, from the answers sent with this report (or the last autosave).
  if (settings.enabled && settings.maxViolations > 0 && violations >= settings.maxViolations) {
    const qs = await getQuestions(a.sprint_id);
    const answers = b.answers ? cleanAnswers(b.answers, qs) : cleanAnswers(await readDraft(a), qs);
    s.endedBy = 'violations';
    await run('UPDATE attempts SET proctor = ? WHERE id = ?', JSON.stringify(s), a.id);
    try {
      const done = await finalizeAttempt(a, answers, true);
      await run('INSERT INTO attempt_events (attempt_id, roll_no, type, at, instance, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        a.id, a.roll_no, 'submit', now, instance, 'auto: ' + violations + ' violations (limit ' + settings.maxViolations + ')', now);
      return { ok: true, status: 'submitted', violations, max: settings.maxViolations, attempt: done };
    } catch (e) {
      if (e.code !== 'BUSY') throw e;
    }
  }
  return { ok: true, status: 'running', violations, max: settings.maxViolations };
}

export async function attemptEvents(attemptId) {
  return all('SELECT type, at, instance, detail FROM attempt_events WHERE attempt_id = ? ORDER BY at, id LIMIT ?', attemptId, MAX_EVENTS_PER_ATTEMPT);
}

export function proctorView(a) {
  const s = summary(a);
  return { violations: a.violations || 0, counts: s.counts || {}, multi: !!s.multi, instances: Number(s.instances) || 0, endedBy: s.endedBy || null };
}

