// Student photographs. The browser crops and shrinks the picture to a small JPEG (public/photo.js), so a photo is
// ~10–40 KB and is stored as a data URL in the database: no file storage needed, on every platform.
//   student_photos  roll_no → photo of an account (registration in secure mode, or the portal's "Add your photo")
//   request_photos  registration request → photo, copied to student_photos when the request is approved
import { one, run } from './db.js';

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
