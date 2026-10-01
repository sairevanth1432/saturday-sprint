// Unit content: every unit (lesson) has three steps, each with a default from content/units.json that an admin can replace:
//   watch → MP4 video      play → HTML page (interactive game)      read → HTML page (notes)
// Sources, highest priority first: admin upload (Admin → Learning bytes) → folder file (watch only:
// server/public/learning-bytes/<unitId>.mp4) → the default copied in at build time (public/packs/).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { one, all, run, parseJSON } from './db.js';
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
export function lessons() {
  if (!lessonsCache) lessonsCache = fs.existsSync(config.lessonsFile) ? JSON.parse(fs.readFileSync(config.lessonsFile, 'utf8')) : [];
  return lessonsCache;
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

// Units generated by `npm run build` from content/units.json.
let unitsCache = null;
export function packUnits() {
  if (!unitsCache) {
    const f = path.join(path.dirname(config.lessonsFile), 'units.json');
    unitsCache = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { mode: 'append', units: [] };
  }
  return unitsCache;
}
