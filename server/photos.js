// Student photographs. The browser crops and shrinks the picture to a small JPEG (public/photo.js), so a photo is
// ~10–40 KB and is stored as a data URL in the database: no file storage needed, on every platform.
//   student_photos  roll_no → photo of an account (registration in secure mode, or the portal's "Add your photo")
//   request_photos  registration request → photo, copied to student_photos when the request is approved
import { one, all, run } from './db.js';

// ---------- photos as ZIP files for admins (Admin → Master data → Profile photos)
// A Vercel response is at most 4.5 MB, so a university's photos come in parts of up to ~3.5 MB each.
const PART_BYTES = 3.5 * 1048576;
const photoRows = (university) => all(`SELECT p.roll_no, length(p.photo) AS len FROM student_photos p JOIN students_master m ON m.roll_no = p.roll_no
  WHERE m.active = 1${university ? ' AND m.university = ?' : ''} ORDER BY p.roll_no`, ...(university ? [university] : []));
export async function photoParts(university) {
  const parts = [];
  let cur = null;
  for (const r of await photoRows(university)) {
    const b = Math.ceil(Number(r.len) * 0.75);
    if (!cur || cur.bytes + b > PART_BYTES) parts.push(cur = { first: r.roll_no, last: r.roll_no, n: 0, bytes: 0 });
    cur.last = r.roll_no; cur.n++; cur.bytes += b;
  }
  return parts;
}
export async function photosZip(university, first, last) {
  const rows = await all(`SELECT p.roll_no, p.photo FROM student_photos p JOIN students_master m ON m.roll_no = p.roll_no
    WHERE m.active = 1 AND p.roll_no >= ? AND p.roll_no <= ?${university ? ' AND m.university = ?' : ''} ORDER BY p.roll_no`, first, last, ...(university ? [university] : []));
  const files = [];
  for (const r of rows) {
    const m = /^data:image\/([a-z]+);base64,(.*)$/.exec(r.photo || '');
    if (m) files.push({ name: r.roll_no + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]), data: Buffer.from(m[2], 'base64') });
  }
  return zipStore(files);
}
// Minimal ZIP writer (stored, no compression: JPEGs do not shrink).
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (const x of buf) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
export function zipStore(files) {
  const out = [], central = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), crc = crc32(f.data), size = f.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(size, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(size, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    out.push(lh, name, f.data); central.push(ch, name);
    off += 30 + name.length + size;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...out, cd, end]);
}

export const MAX_PHOTO_CHARS = 400 * 1024; // data URL length (≈ 300 KB image); the browser sends ~40 KB
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;

export class PhotoError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

export function checkPhoto(raw) {
  const p = typeof raw === 'string' ? raw.trim() : '';
  if (!p) throw new PhotoError('PHOTO_REQUIRED', 'Add your photograph to continue.');
  if (p.length > MAX_PHOTO_CHARS) throw new PhotoError('PHOTO_TOO_LARGE', 'That photo is too large. Choose a smaller picture.', 413);
  if (!PHOTO_RE.test(p)) throw new PhotoError('PHOTO_INVALID', 'That file is not a photo. Use a JPG or PNG picture.');
  return p;
}

export async function saveStudentPhoto(roll, photo) {
  await run(`INSERT INTO student_photos (roll_no, photo, updated_at) VALUES (?, ?, ?)
             ON CONFLICT (roll_no) DO UPDATE SET photo = excluded.photo, updated_at = excluded.updated_at`, roll, photo, Date.now());
}
export async function saveRequestPhoto(requestId, photo) {
  await run(`INSERT INTO request_photos (request_id, photo, created_at) VALUES (?, ?, ?)
             ON CONFLICT (request_id) DO UPDATE SET photo = excluded.photo, created_at = excluded.created_at`, requestId, photo, Date.now());
}
// On approval: the photo sent with the registration becomes the account's photo.
export async function copyRequestPhoto(requestId, roll) {
  const r = await one('SELECT photo FROM request_photos WHERE request_id = ?', requestId);
  if (r) await saveStudentPhoto(roll, r.photo);
}
export const photoStamp = async (roll) => {
  const r = await one('SELECT updated_at FROM student_photos WHERE roll_no = ?', roll);
  return r ? r.updated_at : 0;
};
export const studentPhoto = (roll) => one('SELECT photo, updated_at FROM student_photos WHERE roll_no = ?', roll);
export const requestPhoto = (id) => one('SELECT photo, created_at AS updated_at FROM request_photos WHERE request_id = ?', id);

// Sends a stored data URL as an image. Private: photos are only for the student and admins.
export function sendPhoto(res, row) {
  if (!row) return res.status(404).type('text/plain').send('No photo');
  const m = /^data:(image\/[a-z]+);base64,(.*)$/.exec(row.photo);
  if (!m) return res.status(404).type('text/plain').send('No photo');
  res.set({ 'Content-Type': m[1], 'Cache-Control': 'private, max-age=86400', 'Content-Security-Policy': "default-src 'none'" });
  res.send(Buffer.from(m[2], 'base64'));
}
