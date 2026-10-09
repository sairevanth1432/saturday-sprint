// Student master data (NIAT ID + phone): CSV or Excel (.xlsx) parsing, validation and import.
//   • Admin console upload (works everywhere, including Vercel)
//   • `npm run import-students -- file.xlsx` from any computer with DATABASE_URL
//   • Local / self-hosted server: data/students.xlsx (or data/students.csv) is watched and re-imported when it changes
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { one, all, run, tx, getSetting, setSetting } from './db.js';
import { normRoll, validRoll, normPhone, sha256 } from './security.js';

// Header names we recognise (case/spacing/punctuation-insensitive).
const ALIASES = {
  // The student's login ID. "NIAT ID" is used by the Alard/NIAT sheets; the others are accepted for other sources.
  roll_no: ['niatid', 'niat', 'rollno', 'rollnumber', 'roll', 'studentid', 'id', 'registrationno', 'registrationnumber', 'regno', 'admissionno', 'enrollmentno', 'enrolmentno', 'uid'],
  lms_id: ['userid', 'lmsid', 'lmsuserid'],
  name: ['name', 'studentname', 'fullname', 'student'],
  phone: ['phone', 'phoneno', 'phonenumber', 'mobile', 'mobileno', 'mobilenumber', 'contact', 'contactno', 'contactnumber', 'whatsapp', 'whatsappnumber'],
  batch: ['batch', 'section', 'class', 'cohort', 'group', 'campus'],
  email: ['email', 'emailid', 'emailids', 'emailaddress', 'mail'],
  university: ['university', 'universityname', 'college', 'collegename', 'institute', 'institutename', 'institution', 'uni']
};
const keyOf = (h) => {
  const k = String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [field, names] of Object.entries(ALIASES)) if (names.includes(k)) return field;
  return null;
};

export function parseCSV(text) {
  text = String(text).replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"' && field === '') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

// Excel: first sheet, every cell as text (phone numbers stored as numbers become plain digits).
export async function rowsFromXlsx(buffer) {
  const readXlsxFile = (await import('read-excel-file/node')).default;
  const out = await readXlsxFile(buffer);
  const data = Array.isArray(out) && out[0] && out[0].data !== undefined ? out[0].data : out;
  return data
    .map((r) => r.map((c) => (c == null ? '' : c instanceof Date ? c.toISOString().slice(0, 10) : String(c))))
    .filter((r) => r.some((x) => x.trim() !== ''));
}

// Accepts rows, CSV text, { csv }, { xlsxBase64 } (admin upload) or { path } (.csv / .xlsx file).
export async function rowsFrom(input) {
  if (Array.isArray(input)) return input;
  if (input && input.xlsxBase64) return rowsFromXlsx(Buffer.from(input.xlsxBase64, 'base64'));
  if (input && input.path) return /\.xlsx$/i.test(input.path) ? rowsFromXlsx(fs.readFileSync(input.path)) : parseCSV(fs.readFileSync(input.path, 'utf8'));
  return parseCSV(input && typeof input === 'object' ? input.csv || '' : input);
}

export function readStudents(input) {
  const rows = Array.isArray(input) ? input : parseCSV(input);
  if (!rows.length) return { error: 'The file is empty.', students: [], errors: [], warnings: [] };
  const header = rows[0].map(keyOf);
  const col = (f) => header.indexOf(f);
  // Only the NIAT ID is required. Phone is optional: students register with their own number and an admin
  // approves; a phone in the sheet is shown to the admin to compare.
  if (col('roll_no') < 0) {
    return {
      error: 'Header row must include a "NIAT ID" column. Found: ' + rows[0].join(', ') +
        '. Expected something like: NIAT ID, Student Name, Phone No., Email IDs',
      students: [], errors: [], warnings: []
    };
  }
  const students = [], errors = [], warnings = [], seen = new Map(), phones = new Map();
  const get = (r, f) => (col(f) >= 0 ? String(r[col(f)] ?? '').trim() : '');
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const roll = normRoll(get(r, 'roll_no')), rawPhone = get(r, 'phone'), phone = normPhone(rawPhone);
    if (!roll) return errors.push({ line, roll: '', error: 'Missing NIAT ID' });
    if (!validRoll(roll)) return errors.push({ line, roll, error: 'NIAT ID has unsupported characters' });
    if (rawPhone && !phone) warnings.push({ line, roll, warning: 'Phone "' + rawPhone + '" is not a valid mobile number; stored without phone' });
    if (seen.has(roll)) return errors.push({ line, roll, error: 'Duplicate NIAT ID (first seen on line ' + seen.get(roll) + ')' });
    seen.set(roll, line);
    if (phone && phones.has(phone)) warnings.push({ line, roll, warning: 'Same phone as ' + phones.get(phone) });
    else if (phone) phones.set(phone, roll);
    students.push({ roll_no: roll, name: get(r, 'name'), phone: phone || '', batch: get(r, 'batch'), email: get(r, 'email').toLowerCase(), lms_id: get(r, 'lms_id'),
      university: get(r, 'university').replace(/\s+/g, ' ').slice(0, 120) });
  });
  return { error: null, students, errors, warnings, rowsTotal: rows.length - 1, hasUniversity: col('university') >= 0 };
}

// Upsert into students_master. fullSync: file-sourced students missing from this upload are deactivated.
export async function importStudents(input, { source = 'file', fileName = '', adminId = null, fullSync = true } = {}) {
  const parsed = readStudents(await rowsFrom(input));
  const res = { rowsTotal: parsed.rowsTotal || 0, inserted: 0, updated: 0, unchanged: 0, reactivated: 0, deactivated: 0,
    errors: parsed.errors, warnings: parsed.warnings, error: parsed.error };
  if (parsed.error) return res;
  if (!parsed.students.length) { res.error = 'No valid rows found, nothing was imported.'; return res; }
  const now = Date.now();
  await tx(async () => {
    const existing = new Map((await all('SELECT roll_no, name, phone, batch, email, lms_id, university, active FROM students_master')).map((r) => [r.roll_no, r]));
    const changed = [];
    for (const s of parsed.students) {
      const cur = existing.get(s.roll_no);
      // A sheet without a University column keeps each student's university as it is.
      if (!parsed.hasUniversity) s.university = cur ? cur.university || '' : '';
      if (!cur) { res.inserted++; changed.push(s); }
      else if (cur.name !== s.name || cur.phone !== s.phone || cur.batch !== s.batch || cur.email !== s.email || (cur.lms_id || '') !== s.lms_id || (cur.university || '') !== s.university || !cur.active) {
        if (!cur.active) res.reactivated++;
        res.updated++; changed.push(s);
      } else res.unchanged++;
    }
    // Batched upsert: 500 rows per statement keeps 15k-row files fast.
    for (let i = 0; i < changed.length; i += 500) {
      const chunk = changed.slice(i, i + 500), vals = [], params = [];
      for (const s of chunk) { vals.push('(?, ?, ?, ?, ?, ?, ?, 1, ?, ?)'); params.push(s.roll_no, s.name, s.phone, s.batch, s.email, s.lms_id, s.university, source, now); }
      await run(`INSERT INTO students_master (roll_no, name, phone, batch, email, lms_id, university, active, source, updated_at) VALUES ${vals.join(', ')}
        ON CONFLICT (roll_no) DO UPDATE SET name = excluded.name, phone = excluded.phone, batch = excluded.batch, email = excluded.email,
        lms_id = excluded.lms_id, university = excluded.university, active = 1, source = excluded.source, updated_at = excluded.updated_at`, ...params);
    }
    if (fullSync) {
      const keep = new Set(parsed.students.map((s) => s.roll_no));
      const gone = (await all("SELECT roll_no FROM students_master WHERE active = 1 AND source = 'file'")).map((r) => r.roll_no).filter((r) => !keep.has(r));
      for (let i = 0; i < gone.length; i += 1000) {
        const chunk = gone.slice(i, i + 1000);
        await run(`UPDATE students_master SET active = 0, updated_at = ? WHERE roll_no IN (${chunk.map(() => '?').join(', ')})`, now, ...chunk);
      }
      res.deactivated = gone.length;
    }
    await run('INSERT INTO imports (source, file_name, rows_total, inserted, updated, unchanged, deactivated, errors, admin_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      source, fileName, res.rowsTotal, res.inserted, res.updated, res.unchanged, res.deactivated,
      JSON.stringify({ errors: res.errors.slice(0, 500), warnings: res.warnings.slice(0, 500) }), adminId, now);
  });
  return res;
}

export function logImport(label, r) {
  if (r.error) return console.warn(`[students] ${label}: ${r.error}`);
  console.log(`[students] ${label}: ${r.rowsTotal} rows · ${r.inserted} new · ${r.updated} updated · ${r.unchanged} unchanged · ` +
    `${r.deactivated} deactivated · ${r.errors.length} rejected` + (r.errors.length ? ' (see Admin → Master data)' : ''));
}

// The watched master file: STUDENTS_FILE if set, else data/students.xlsx, else data/students.csv.
export function studentsFilePath() {
  if (process.env.STUDENTS_FILE) return config.studentsFile;
  const dir = path.dirname(config.studentsFile);
  for (const f of ['students.xlsx', 'students.csv']) if (fs.existsSync(path.join(dir, f))) return path.join(dir, f);
  return path.join(dir, 'students.xlsx');
}

export async function syncStudentsFile({ force = false, adminId = null } = {}) {
  const file = studentsFilePath();
  if (!fs.existsSync(file)) return { error: 'File not found: ' + file, missing: true };
  const hash = sha256(fs.readFileSync(file).toString('base64'));
  if (!force && (await getSetting('students_file_hash')) === hash) return { skipped: true };
  const r = await importStudents({ path: file }, { source: 'file', fileName: path.basename(file), adminId, fullSync: true });
  if (!r.error) await setSetting('students_file_hash', hash);
  logImport(path.basename(file), r);
  return r;
}

export function watchStudentsFile() {
  const file = studentsFilePath();
  if (!fs.existsSync(file)) {
    console.warn(`[students] No master file yet. Save the student sheet (Excel or CSV) as:\n           ${file}\n           (columns: NIAT ID, Student Name, Phone No., Email IDs, University). It loads automatically, or upload it in Admin → Master data.`);
  } else syncStudentsFile().catch((e) => console.error('[students] import failed:', e.message));
  let timer = null;
  const dir = path.dirname(config.studentsFile);
  const watched = process.env.STUDENTS_FILE ? [config.studentsFile] : [path.join(dir, 'students.xlsx'), path.join(dir, 'students.csv')];
  for (const f of watched) {
    fs.watchFile(f, { interval: 2000 }, (cur) => {
      if (!cur.mtimeMs) return;
      clearTimeout(timer);
      timer = setTimeout(() => syncStudentsFile().catch((e) => console.error('[students] reload failed:', e.message)), 800);
    });
  }
}

export const studentCounts = () => one(`SELECT
    (SELECT COUNT(*) FROM students_master WHERE active = 1) AS master_active,
    (SELECT COUNT(*) FROM students_master WHERE active = 0) AS master_inactive,
    (SELECT COUNT(*) FROM users) AS registered,
    (SELECT COUNT(*) FROM users WHERE status = 'disabled') AS disabled`);
