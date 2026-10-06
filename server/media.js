// Unit content: every unit (lesson) has three steps, each with a default from content/units.json that an admin can replace:
//   watch → MP4 video      play → HTML page (interactive game)      read → HTML page (notes)
// Sources, highest priority first: admin upload (Admin → Learning bytes) → folder file (watch only:
// server/public/learning-bytes/<unitId>.mp4) → the default copied in at build time (public/packs/).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { one, all, run, tx, parseJSON, setSetting } from './db.js';
import * as kv from './kv.js';

export const SLOTS = ['watch', 'play', 'read'];
export const VIDEO_TYPES = ['video/mp4', 'video/webm'];
export const HTML_TYPES = ['text/html'];
// Watch videos go to file storage (R2/S3, Vercel Blob or local disk). Play/Read HTML is stored in the database
// and served by this site at /api/content/<unit>/<slot> (works everywhere, and Vercel Blob cannot host HTML pages).
export const typesFor = (slot) => (slot === 'watch' ? VIDEO_TYPES : HTML_TYPES);
export const maxBytesFor = (slot) => (slot === 'watch' ? config.maxVideoBytes : 3 * 1024 * 1024); // HTML: fits Vercel's 4.5 MB request limit
const EXT = /\.(mp4|webm)$/i;

let lessonsCache = null;
// Built-in lessons (generated/lessons.json) followed by the topics admins added (Admin → Courses & topics).
export function lessons() {
  if (!lessonsCache) lessonsCache = fs.existsSync(config.lessonsFile) ? JSON.parse(fs.readFileSync(config.lessonsFile, 'utf8')) : [];
  return lessonsCache.filter((l) => !isHidden(l)).concat(customLessons());
}
// Built-in lessons that a super admin removed (Admin → Courses & topics → Delete). They can be restored.
export function hiddenLessons() {
  if (!lessonsCache) lessons();
  return lessonsCache.filter((l) => isHidden(l) && l.kind === 'unit');
}
export const lessonIds = () => new Set(lessons().map((l) => l.id));

// Folder videos. Locally the folder is scanned live; on Vercel a manifest is generated at build (scripts/build-portal.js).
export function folderBytes() {
  if (!config.isVercel && fs.existsSync(config.learningBytesDir)) return scanFolder(config.learningBytesDir);
  return fs.existsSync(config.folderBytesFile) ? JSON.parse(fs.readFileSync(config.folderBytesFile, 'utf8')) : {};
}
export function scanFolder(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const ids = lessonIds();
  for (const f of fs.readdirSync(dir)) {
    if (!EXT.test(f)) continue;
    const id = f.replace(EXT, '');
    if (!ids.has(id)) continue;
    const st = fs.statSync(path.join(dir, f));
    out[id] = { url: '/learning-bytes/' + encodeURIComponent(f) + '?v=' + Math.floor(st.mtimeMs / 1000), file_name: f, size_bytes: st.size, storage: 'folder' };
  }
  return out;
}

// unitId → { watch?, play?, read? } overrides (uploads and folder videos) for the portal. Cached 30 s.
export async function unitContentMap() {
  return kv.cached('unitcontent:v1', 30, async () => {
    const out = {};
    for (const [id, b] of Object.entries(folderBytes())) (out[id] = out[id] || {}).watch = b.url;
    for (const r of await all('SELECT unit_id, slot, url FROM unit_content')) (out[r.unit_id] = out[r.unit_id] || {})[r.slot] = r.url;
    return out;
  }, { localMs: 10000 });
}
export const clearContentCache = () => kv.invalidate('unitcontent:v1');

// Admin listing: every unit with what each step shows now.
export async function catalog() {
  const folder = folderBytes();
  const uploads = await all('SELECT unit_id, slot, url, storage, file_name, size_bytes, content_type, updated_by, updated_at FROM unit_content');
  return lessons().map((l) => {
    const d = l.defaults || {};
    const steps = {};
    for (const slot of SLOTS) {
      const up = uploads.find((u) => u.unit_id === l.id && u.slot === slot) || null;
      const fd = slot === 'watch' ? folder[l.id] || null : null;
      const def = d[slot] || null;
      steps[slot] = { upload: up, folder: fd, default: def, active: up ? 'upload' : fd ? 'folder' : def ? 'pack' : 'none', url: up ? up.url : fd ? fd.url : def };
    }
    return { ...l, steps };
  });
}

// Play/Read HTML stored in the database. The URL carries the update time so the CDN can cache it safely.
export async function setHtmlContent(unitId, slot, { html, fileName, by }) {
  const now = Date.now();
  await setContent(unitId, slot, { url: `/api/content/${encodeURIComponent(unitId)}/${slot}?v=${now}`, storage: 'db', fileName, size: Buffer.byteLength(html), contentType: 'text/html', by, body: html });
}
export const htmlContent = (unitId, slot) => one("SELECT body, updated_at FROM unit_content WHERE unit_id = ? AND slot = ? AND storage = 'db'", unitId, slot);

export async function setContent(unitId, slot, { url, storage, fileName, size, contentType, by, body = null }) {
  const prev = await one('SELECT * FROM unit_content WHERE unit_id = ? AND slot = ?', unitId, slot);
  await run(`INSERT INTO unit_content (unit_id, slot, url, storage, file_name, size_bytes, content_type, updated_by, updated_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (unit_id, slot) DO UPDATE SET url = excluded.url, storage = excluded.storage, file_name = excluded.file_name, size_bytes = excluded.size_bytes,
             content_type = excluded.content_type, updated_by = excluded.updated_by, updated_at = excluded.updated_at, body = excluded.body`,
    unitId, slot, url, storage, fileName || null, size || null, contentType || null, by || null, Date.now(), body);
  await clearContentCache();
  if (prev && prev.url !== url) await deleteFile(prev);
}

export async function removeContent(unitId, slot) {
  const r = await one('SELECT * FROM unit_content WHERE unit_id = ? AND slot = ?', unitId, slot);
  if (!r) return null;
  await run('DELETE FROM unit_content WHERE unit_id = ? AND slot = ?', unitId, slot);
  await clearContentCache();
  await deleteFile(r);
  return r;
}

async function deleteFile(r) {
  try {
    if (r.storage === 's3') await deleteStored(r.url);
    if (r.storage === 'blob' && config.blobToken) { const { del } = await import('@vercel/blob'); await del(r.url, { token: config.blobToken }); }
    if (r.storage === 'local') { const f = path.join(config.localUploadsDir, path.basename(new URL(r.url, 'http://x').pathname)); if (fs.existsSync(f)) fs.unlinkSync(f); }
  } catch (e) { console.warn('[media] could not delete old file:', e.message); }
}

// ---------- storage backends for admin uploads
const S3 = config.s3;
export const s3Enabled = () => !!(S3.endpoint && S3.bucket && S3.accessKeyId && S3.secretAccessKey && S3.publicUrl);
export const blobEnabled = () => !!config.blobToken;
export const storageKind = () => (s3Enabled() ? 's3' : blobEnabled() ? 'blob' : config.isVercel ? 'none' : 'local');
export const isBlobUrl = (u) => { try { return /\.blob\.vercel-storage\.com$/.test(new URL(u).hostname); } catch { return false; } };
export const isS3Url = (u) => s3Enabled() && typeof u === 'string' && u.startsWith(S3.publicUrl + '/learning-bytes/');
export const extFor = (slot, contentType) => (slot === 'watch' ? (contentType === 'video/webm' ? 'webm' : 'mp4') : 'html');

let aws = null;
async function awsClient() {
  if (!aws) { const { AwsClient } = await import('aws4fetch'); aws = new AwsClient({ accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey, service: 's3', region: S3.region }); }
  return aws;
}
const objectUrl = (key) => `${S3.endpoint}/${S3.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

// A short-lived signed URL the admin's browser PUTs the file to (the file never passes through this server).
export async function presignUpload(unitId, slot, contentType) {
  const key = `learning-bytes/${unitId}-${slot}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${extFor(slot, contentType)}`;
  const url = new URL(objectUrl(key));
  url.searchParams.set('X-Amz-Expires', '3600');
  const signed = await (await awsClient()).sign(new Request(url, { method: 'PUT' }), { aws: { signQuery: true } });
  return { uploadUrl: signed.url, publicUrl: `${S3.publicUrl}/${key}`, key };
}
async function deleteStored(publicUrl) {
  if (!isS3Url(publicUrl)) return;
  const key = publicUrl.slice(S3.publicUrl.length + 1);
  await (await awsClient()).fetch(objectUrl(key), { method: 'DELETE' });
}
export { deleteStored };
export const parseClientPayload = (p) => parseJSON(p, {}) || {};

// Units generated by `npm run build` from content/units.json, then the topics admins added.
let unitsCache = null;
function builtUnits() {
  if (!unitsCache) {
    const f = path.join(path.dirname(config.lessonsFile), 'units.json');
    unitsCache = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { mode: 'append', units: [] };
  }
  return unitsCache;
}
// "replaced": the built-in courses whose original lessons the units replace (mode "replace"), even when an admin
// removed every unit of that course, so the portal never falls back to the original lessons.
export function packUnits() {
  const b = builtUnits();
  const replaced = b.mode === 'replace' ? [...new Set((b.units || []).map((u) => u.course))] : [];
  return { ...b, replaced, hiddenCourses: custom.hidden.courses.slice(), units: (b.units || []).filter((u) => !isHidden(u)).concat(customUnits()) };
}

// ---------- courses and topics added by admins (content_courses / content_units)
// Kept in a per-instance snapshot so packUnits()/lessons() stay synchronous; syncContent() refreshes it
// (cached 30 s across instances, 5 s per instance) and runs before every /api request.
export const BUILTIN_COURSES = [{ id: 'pf', name: 'Programming Foundations' }, { id: 'genai', name: 'Intro to GenAI' }];
let custom = { courses: [], units: [], hidden: { courses: [], units: [] } };
export async function syncContent() {
  const c = await kv.cached('content:v1', 30, async () => {
    const h = await one("SELECT value FROM settings WHERE key = 'content_hidden'");
    return {
      courses: await all('SELECT id, name, color, sort, created_at FROM content_courses ORDER BY sort, created_at'),
      units: await all('SELECT id, course, title, goal, concept, orientation, practice_topic, sort, created_at FROM content_units ORDER BY sort, created_at'),
      hidden: parseJSON(h && h.value, null) || { courses: [], units: [] }
    };
  }, { localMs: 5000 });
  custom = { ...c, hidden: { courses: (c.hidden && c.hidden.courses) || [], units: (c.hidden && c.hidden.units) || [] } };
  return custom;
}
// A built-in unit is hidden when it, or its whole built-in course, was removed by an admin.
const isHidden = (u) => custom.hidden.units.includes(u.id) || custom.hidden.courses.includes(u.course);
export const hiddenState = () => ({ courses: custom.hidden.courses.slice(), units: custom.hidden.units.slice() });
export const builtinCourses = () => BUILTIN_COURSES.filter((c) => !custom.hidden.courses.includes(c.id));
export const clearCustomCache = async () => { await kv.invalidate('content:v1'); custom = await syncContent(); };
export const customCourses = () => custom.courses;
export const courseNames = () => Object.fromEntries(builtinCourses().concat(custom.courses).map((c) => [c.id, c.name]));
// Units of a course in the order the portal shows them (built-in first, then admin-added by position).
function customUnits() {
  const order = new Map(builtinCourses().concat(custom.courses).map((c, i) => [c.id, i]));
  return custom.units.filter((u) => order.has(u.course)).map((u) => ({
    id: u.id, course: u.course, name: u.title, color: '#FFE45C', practiceTopic: u.practice_topic || '', custom: true,
    lessons: [{ id: u.id, kind: 'video', title: u.title, goal: u.goal || '', tabs: { watch: null, play: null, read: null },
      watch: { type: 'video', src: '', title: u.title, orientation: u.orientation === 'portrait' ? 'portrait' : 'landscape' } }]
  }));
}
function customLessons() {
  const names = courseNames();
  return customUnits().map((u) => {
    const r = custom.units.find((x) => x.id === u.id);
    return { id: u.id, course: u.course, courseName: names[u.course] || u.course, module: u.name, title: u.name, goal: r.goal || '', concept: r.concept || '',
      kind: 'unit', custom: true, orientation: r.orientation, practiceTopic: r.practice_topic || '', sort: r.sort, hasExplainer: false, defaults: {} };
  });
}

// ---------- Admin → Courses & topics: create, edit, reorder and delete admin-added courses and topics
export class ContentError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const RESERVED_COURSES = new Set(['pf', 'genai', 'wad']);

export async function addCourse({ name }, by) {
  const n = clean(name, 80);
  if (n.length < 2) throw new ContentError('BAD_NAME', 'Give the course a name.');
  await syncContent();
  // Course ids are letters only: progress keys and analytics read them as "<course>-<topic>-<lesson>".
  const base = (n.toLowerCase().replace(/[^a-z]/g, '') || 'course').slice(0, 20);
  const taken = new Set([...RESERVED_COURSES, ...custom.courses.map((c) => c.id)]);
  let id = base;
  for (let i = 0; taken.has(id); i++) id = base + 'abcdefghijklmnopqrstuvwxyz'[i % 26].repeat(1 + Math.floor(i / 26));
  const sort = custom.courses.reduce((m, c) => Math.max(m, c.sort), 0) + 1;
  await run('INSERT INTO content_courses (id, name, sort, created_at, created_by) VALUES (?, ?, ?, ?, ?)', id, n, sort, Date.now(), by || null);
  await clearCustomCache();
  return { id, name: n };
}

export async function updateCourse(id, { name }) {
  const n = clean(name, 80);
  if (n.length < 2) throw new ContentError('BAD_NAME', 'Give the course a name.');
  const r = await one('UPDATE content_courses SET name = ? WHERE id = ? RETURNING id', n, id);
  if (!r) throw new ContentError('NOT_FOUND', 'Only courses added here can be renamed.', 404);
  await clearCustomCache();
}

export async function deleteCourse(id) {
  if (!(await one('SELECT id FROM content_courses WHERE id = ?', id))) throw new ContentError('NOT_FOUND', 'Only courses added here can be deleted.', 404);
  if (await one('SELECT id FROM content_units WHERE course = ? LIMIT 1', id)) throw new ContentError('NOT_EMPTY', 'Delete the topics of this course first.', 409);
  await run('DELETE FROM content_courses WHERE id = ?', id);
  await clearCustomCache();
}

function unitFields(b, partial) {
  const f = {};
  if (!partial || b.title !== undefined) { f.title = clean(b.title, 120); if (f.title.length < 2) throw new ContentError('BAD_TITLE', 'Give the topic a title.'); }
  if (!partial || b.goal !== undefined) f.goal = clean(b.goal, 300);
  if (!partial || b.concept !== undefined) f.concept = clean(b.concept, 500);
  if (!partial || b.orientation !== undefined) f.orientation = b.orientation === 'portrait' ? 'portrait' : 'landscape';
  if (!partial || b.practiceTopic !== undefined) f.practice_topic = clean(b.practiceTopic, 120);
  return f;
}

export async function addUnit(b, by) {
  await syncContent();
  const course = String(b.course || '');
  if (!courseNames()[course]) throw new ContentError('BAD_COURSE', 'Pick a course for the topic.');
  const f = unitFields(b, false);
  const base = 'u-' + (f.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'topic');
  const taken = new Set(lessons().map((l) => l.id));
  let id = base;
  for (let i = 2; taken.has(id); i++) id = base + '-' + i;
  const sort = custom.units.filter((u) => u.course === course).reduce((m, u) => Math.max(m, u.sort), 0) + 1;
  await run('INSERT INTO content_units (id, course, title, goal, concept, orientation, practice_topic, sort, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, course, f.title, f.goal, f.concept, f.orientation, f.practice_topic, sort, Date.now(), by || null);
  await clearCustomCache();
  return { id, title: f.title };
}

export async function updateUnit(id, b) {
  const f = unitFields(b, true), keys = Object.keys(f);
  if (!keys.length) return;
  const r = await one(`UPDATE content_units SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ? RETURNING id`, ...keys.map((k) => f[k]), id);
  if (!r) throw new ContentError('NOT_FOUND', 'Only topics added here can be edited.', 404);
  await clearCustomCache();
}

// Moves a topic one place up or down among the admin-added topics of its course.
export async function moveUnit(id, dir) {
  await syncContent();
  const u = custom.units.find((x) => x.id === id);
  if (!u) throw new ContentError('NOT_FOUND', 'Only topics added here can be moved.', 404);
  const list = custom.units.filter((x) => x.course === u.course);
  const i = list.findIndex((x) => x.id === id), j = i + (dir < 0 ? -1 : 1);
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  await tx(async () => { for (let k = 0; k < list.length; k++) await run('UPDATE content_units SET sort = ? WHERE id = ?', k + 1, list[k].id); });
  await clearCustomCache();
}

export async function deleteUnit(id) {
  if (!(await one('SELECT id FROM content_units WHERE id = ?', id))) throw new ContentError('NOT_FOUND', 'Only topics added here can be deleted.', 404);
  await syncContent();
  const before = custom.units;
  custom = { ...custom, units: before.filter((u) => u.id !== id) };
  try { leavesSomething(hiddenState()); } finally { custom = { ...custom, units: before }; }
  for (const slot of SLOTS) await removeContent(id, slot);
  await run('DELETE FROM content_units WHERE id = ?', id);
  await clearCustomCache();
}

// ---------- removing built-in courses and topics (from content/units.json): they are hidden, not deleted, so
// they can be restored. Removing a built-in course hides all of its units and the topics admins added to it.
async function saveHidden(h) {
  await setSetting('content_hidden', { courses: [...new Set(h.courses)], units: [...new Set(h.units)] });
  await clearCustomCache();
}
// Students must always have at least one course with a topic in Learn.
function leavesSomething(h) {
  const hiddenUnit = (u) => h.units.includes(u.id) || h.courses.includes(u.course);
  const built = (builtUnits().units || []).some((u) => !hiddenUnit(u));
  const added = custom.units.some((u) => !h.courses.includes(u.course));
  if (!built && !added) throw new ContentError('LAST_TOPIC', 'Students need at least one topic in Learn. Add another topic before removing this one.', 409);
}
const builtinUnitIds = () => new Set((builtUnits().units || []).map((u) => u.id));

export async function hideBuiltinUnit(id) {
  await syncContent();
  if (!builtinUnitIds().has(id)) throw new ContentError('NOT_FOUND', 'Unknown topic.', 404);
  const h = hiddenState();
  h.units.push(id);
  leavesSomething(h);
  await saveHidden(h);
}
export async function hideBuiltinCourse(id) {
  await syncContent();
  if (!BUILTIN_COURSES.some((c) => c.id === id)) throw new ContentError('NOT_FOUND', 'Unknown course.', 404);
  const h = hiddenState();
  h.courses.push(id);
  leavesSomething(h);
  await saveHidden(h);
}
export async function restoreBuiltin(kind, id) {
  await syncContent();
  const h = hiddenState();
  const key = kind === 'course' ? 'courses' : 'units';
  if (!h[key].includes(id)) throw new ContentError('NOT_FOUND', 'Nothing to restore.', 404);
  h[key] = h[key].filter((x) => x !== id);
  await saveHidden(h);
}
