// Recycle bin (Admin → Recycle bin): whatever an admin deletes in the console lands here first, with a full snapshot,
// and can be restored. "Delete forever" empties one item (and only then removes uploaded files from storage).
//   topic      an added topic (content_units) and its uploaded Watch / Play / Read files
//   course     an added course (content_courses; it has no topics left when it is deleted)
//   media      one uploaded step file of a topic
//   question   a Sprint test question (sprint_questions)
//   attempt    a student's Sprint attempt that was reset (attempts + attempt_events)
//   account    a student's registration that was reset (users)
// Removed (hidden) topics and courses are not in this table: they are listed next to it and restored the usual way.
import { one, all, run, tx, parseJSON } from './db.js';

export class BinError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; }
}
export const BIN_KINDS = { topic: 'Topic', course: 'Course', media: 'Uploaded file', question: 'Sprint question', attempt: 'Test attempt', account: 'Student registration' };

export async function binPut(kind, ref, label, payload, by) {
  if (!BIN_KINDS[kind]) throw new Error('unknown recycle bin kind ' + kind);
  const r = await one('INSERT INTO recycle_bin (kind, ref, label, payload, deleted_at, deleted_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    kind, String(ref || ''), String(label || '').slice(0, 300), JSON.stringify(payload ?? null), Date.now(), by || null);
  return Number(r.id);
}

export async function listBin() {
  const rows = await all('SELECT id, kind, ref, label, deleted_at, deleted_by FROM recycle_bin WHERE restored_at IS NULL AND purged_at IS NULL ORDER BY deleted_at DESC LIMIT 1000');
  return rows.map((r) => ({ id: Number(r.id), kind: r.kind, kindLabel: BIN_KINDS[r.kind] || r.kind, ref: r.ref, label: r.label, deletedAt: Number(r.deleted_at), deletedBy: r.deleted_by }));
}

const itemOf = async (id) => {
  const it = await one('SELECT * FROM recycle_bin WHERE id = ? AND restored_at IS NULL AND purged_at IS NULL', Number(id));
  if (!it) throw new BinError('NOT_FOUND', 'This item is no longer in the recycle bin.', 404);
  return { ...it, payload: parseJSON(it.payload, null) };
};

// Re-insert a snapshot row as it was (same id), skipping columns the table no longer has.
async function reinsert(table, row) {
  const cols = (await all("SELECT column_name FROM information_schema.columns WHERE table_name = ?", table)).map((c) => c.column_name);
  const keys = Object.keys(row).filter((k) => cols.includes(k));
  await run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => row[k]));
}

// hooks: functions from the modules that own the data (passed in by index.js to keep this module free of cycles)
export async function restoreItem(id, hooks) {
  const it = await itemOf(id), p = it.payload || {};
  if (it.kind === 'topic') {
    if (!(await one('SELECT id FROM content_units WHERE id = ?', p.unit.id))) await reinsert('content_units', p.unit);
    const course = await one('SELECT id, deleted_at FROM content_courses WHERE id = ?', p.unit.course);
    if (course && course.deleted_at) throw new BinError('COURSE_GONE', 'Restore its course "' + p.unit.course + '" first (it is in the recycle bin too).');
    await run('UPDATE content_units SET deleted_at = NULL WHERE id = ?', p.unit.id);
    for (const c of p.content || []) if (!(await one('SELECT 1 AS x FROM unit_content WHERE unit_id = ? AND slot = ?', c.unit_id, c.slot))) await reinsert('unit_content', c);
    await hooks.contentChanged();
  } else if (it.kind === 'course') {
    await run('UPDATE content_courses SET deleted_at = NULL WHERE id = ?', p.course.id);
    await hooks.contentChanged();
  } else if (it.kind === 'media') {
    if (await one('SELECT 1 AS x FROM unit_content WHERE unit_id = ? AND slot = ?', p.row.unit_id, p.row.slot))
      throw new BinError('SLOT_TAKEN', 'A newer file is uploaded for this step. Remove it first, then restore this one.');
    await reinsert('unit_content', p.row);
    await hooks.contentChanged();
  } else if (it.kind === 'question') {
    await hooks.restoreQuestion(p.row);
  } else if (it.kind === 'attempt') {
    if (await one('SELECT id FROM attempts WHERE sprint_id = ? AND roll_no = ?', p.attempt.sprint_id, p.attempt.roll_no))
      throw new BinError('ATTEMPT_EXISTS', 'This student already has a newer attempt for this Sprint. Reset that one first if you want this one back.');
    await tx(async () => {
      await reinsert('attempts', p.attempt);
      for (const e of p.events || []) await reinsert('attempt_events', e);
    });
    await hooks.boardChanged();
  } else if (it.kind === 'account') {
    if (await one('SELECT id FROM users WHERE roll_no = ?', p.user.roll_no))
      throw new BinError('ACCOUNT_EXISTS', 'This student has registered again since. Their new account stays.');
    await reinsert('users', p.user);
  }
  await run('UPDATE recycle_bin SET restored_at = ? WHERE id = ?', Date.now(), it.id);
  return { kind: it.kind, label: it.label };
}

// Delete forever: the snapshot goes, and uploaded files are removed from storage.
export async function purgeItem(id, hooks) {
  const it = await itemOf(id), p = it.payload || {};
  if (it.kind === 'topic') for (const c of p.content || []) await hooks.deleteFile(c);
  if (it.kind === 'media') await hooks.deleteFile(p.row);
  await run('UPDATE recycle_bin SET purged_at = ?, payload = ? WHERE id = ?', Date.now(), JSON.stringify(null), it.id);
  return { kind: it.kind, label: it.label };
}
