// Postgres everywhere.
//   Production (Vercel): DATABASE_URL → Neon/any Postgres through its connection pooler.
//   Local development:   no DATABASE_URL → PGlite (real Postgres compiled to WASM) in data/pglite. Nothing to install.
// All timestamps are epoch milliseconds (BIGINT). Queries use "?" placeholders; they are converted to $1, $2…
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS students_master (
  roll_no     TEXT PRIMARY KEY,              -- normalised: trimmed, upper-case, no spaces
  name        TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',      -- E.164, e.g. +919876543210
  batch       TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  lms_id      TEXT NOT NULL DEFAULT '',      -- the student's LMS user id ("User id" column), kept for LMS linking
  active      INTEGER NOT NULL DEFAULT 1,    -- 0 = removed from the master list; cannot register or log in
  source      TEXT NOT NULL DEFAULT 'file',  -- file | admin
  updated_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS students_phone ON students_master(phone);
ALTER TABLE students_master ADD COLUMN IF NOT EXISTS lms_id TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS users (
  id             BIGSERIAL PRIMARY KEY,
  roll_no        TEXT NOT NULL UNIQUE REFERENCES students_master(roll_no),  -- one account per roll number
  phone          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',                            -- active | disabled
  created_at     BIGINT NOT NULL,
  last_login_at  BIGINT
);

-- Students register with their own phone; an admin approves each request before the account exists.
CREATE TABLE IF NOT EXISTS registration_requests (
  id           BIGSERIAL PRIMARY KEY,
  roll_no      TEXT NOT NULL,
  phone        TEXT NOT NULL,               -- verified by OTP when the request was made
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | superseded
  note         TEXT,
  ip           TEXT,
  ua           TEXT,
  created_at   BIGINT NOT NULL,
  decided_at   BIGINT,
  decided_by   TEXT
);
CREATE INDEX IF NOT EXISTS regreq_status ON registration_requests(status, created_at);
CREATE INDEX IF NOT EXISTS regreq_roll ON registration_requests(roll_no);
CREATE INDEX IF NOT EXISTS users_phone ON users(phone);

CREATE TABLE IF NOT EXISTS otp_codes (
  id           BIGSERIAL PRIMARY KEY,
  roll_no      TEXT NOT NULL,
  purpose      TEXT NOT NULL,
  phone        TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,
  consumed_at  BIGINT,
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS otp_roll ON otp_codes(roll_no, created_at);

CREATE TABLE IF NOT EXISTS admins (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL DEFAULT '',
  role            TEXT NOT NULL DEFAULT 'admin',
  password_hash   TEXT NOT NULL,
  must_change_pw  INTEGER NOT NULL DEFAULT 0,
  totp_secret     TEXT,
  totp_enabled    INTEGER NOT NULL DEFAULT 0,
  totp_last_step  BIGINT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',
  failed_logins   INTEGER NOT NULL DEFAULT 0,
  locked_until    BIGINT NOT NULL DEFAULT 0,
  created_at      BIGINT NOT NULL,
  last_login_at   BIGINT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash    TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  subject_id    BIGINT NOT NULL,
  stage         TEXT NOT NULL DEFAULT 'full',
  created_at    BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL,
  last_seen_at  BIGINT NOT NULL,
  ip            TEXT,
  ua            TEXT
);
CREATE INDEX IF NOT EXISTS sessions_subject ON sessions(kind, subject_id);

CREATE TABLE IF NOT EXISTS attempts (
  id              BIGSERIAL PRIMARY KEY,
  sprint_id       TEXT NOT NULL,
  roll_no         TEXT NOT NULL,
  status          TEXT NOT NULL,          -- running | submitted
  started_at      BIGINT NOT NULL,
  deadline_at     BIGINT NOT NULL,
  submitted_at    BIGINT,
  auto_submitted  INTEGER NOT NULL DEFAULT 0,
  draft           TEXT,                   -- last autosave (when Redis is not configured)
  answers         TEXT,
  detail          TEXT,
  mcq_score       DOUBLE PRECISION,
  code_score      DOUBLE PRECISION,
  text_score      DOUBLE PRECISION,
  text_reviewed   INTEGER NOT NULL DEFAULT 0,
  total           DOUBLE PRECISION,
  max_total       DOUBLE PRECISION,
  used_ms         BIGINT,
  updated_at      BIGINT NOT NULL,
  UNIQUE (sprint_id, roll_no)
);
CREATE INDEX IF NOT EXISTS attempts_board ON attempts(sprint_id, status, total DESC, used_ms ASC);
CREATE INDEX IF NOT EXISTS attempts_due ON attempts(status, deadline_at);

CREATE TABLE IF NOT EXISTS progress (
  roll_no     TEXT PRIMARY KEY,
  data        TEXT NOT NULL,
  updated_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id          BIGSERIAL PRIMARY KEY,
  roll_no     TEXT,
  kind        TEXT,
  rating      INTEGER,
  text        TEXT,
  data        TEXT,
  created_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  admin_id     BIGINT,
  admin_email  TEXT,
  action       TEXT NOT NULL,
  target       TEXT,
  detail       TEXT,
  ip           TEXT,
  created_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS imports (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT,
  file_name    TEXT,
  rows_total   INTEGER,
  inserted     INTEGER,
  updated      INTEGER,
  unchanged    INTEGER,
  deactivated  INTEGER,
  errors       TEXT,
  admin_id     BIGINT,
  created_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS learning_bytes (
  lesson_id     TEXT PRIMARY KEY,            -- lesson/concept id from the portal (e.g. "pl", "clear")
  url           TEXT NOT NULL,
  storage       TEXT NOT NULL,               -- blob | local
  file_name     TEXT,
  size_bytes    BIGINT,
  content_type  TEXT,
  updated_by    TEXT,
  updated_at    BIGINT NOT NULL
);

-- Admin uploads per unit step: watch (MP4), play (HTML game), read (HTML notes).
CREATE TABLE IF NOT EXISTS unit_content (
  unit_id       TEXT NOT NULL,
  slot          TEXT NOT NULL,               -- watch | play | read
  url           TEXT NOT NULL,
  storage       TEXT NOT NULL,               -- s3 | blob | local
  file_name     TEXT,
  size_bytes    BIGINT,
  content_type  TEXT,
  updated_by    TEXT,
  updated_at    BIGINT NOT NULL,
  PRIMARY KEY (unit_id, slot)
);
-- Play/Read HTML is kept in the database and served by /api/content (Vercel Blob will not serve HTML pages).
ALTER TABLE unit_content ADD COLUMN IF NOT EXISTS body TEXT;

-- Student passwords: set at registration (or after a one-time OTP login), then NIAT ID + password logs in.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_set_at BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until BIGINT NOT NULL DEFAULT 0;
ALTER TABLE registration_requests ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Proctoring for the Sprint test: every tracked event, plus a summary on the attempt.
-- Every student login (simple mode has no secret, so this is the audit trail) and portal activity per day.
CREATE TABLE IF NOT EXISTS student_logins (id BIGSERIAL PRIMARY KEY, roll_no TEXT NOT NULL, at BIGINT NOT NULL, method TEXT NOT NULL, ip TEXT, ua TEXT);
CREATE INDEX IF NOT EXISTS student_logins_roll ON student_logins(roll_no, at);
CREATE INDEX IF NOT EXISTS student_logins_at ON student_logins(at);
-- Active time and opens per student, day (IST), area (home/learn/practice/code/test/board), item (unit / topic) and step.
CREATE TABLE IF NOT EXISTS activity (
  roll_no TEXT NOT NULL, day TEXT NOT NULL, area TEXT NOT NULL, item TEXT NOT NULL DEFAULT '', step TEXT NOT NULL DEFAULT '',
  ms BIGINT NOT NULL DEFAULT 0, opens INTEGER NOT NULL DEFAULT 0, video_ms BIGINT NOT NULL DEFAULT 0, video_pct INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL, PRIMARY KEY (roll_no, day, area, item, step));
CREATE INDEX IF NOT EXISTS activity_day ON activity(day);
-- Sprint test questions, one set per Sprint ID (Admin → Sprint questions). A Sprint with no rows uses the
-- built-in set from the portal HTML (generated/sprint-test.json).
CREATE TABLE IF NOT EXISTS sprint_questions (
  id BIGSERIAL PRIMARY KEY, sprint_id TEXT NOT NULL, position INTEGER NOT NULL, course TEXT NOT NULL, unit_id TEXT NOT NULL DEFAULT '',
  q TEXT NOT NULL, code TEXT NOT NULL DEFAULT '', options TEXT NOT NULL, correct INTEGER NOT NULL,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, updated_by TEXT);
CREATE INDEX IF NOT EXISTS sprint_questions_sprint ON sprint_questions(sprint_id, position);
-- Visits (sessions): one row per page visit, from the portal's activity reports. Tracked from deploy onward.
CREATE TABLE IF NOT EXISTS activity_sessions (session_id TEXT PRIMARY KEY, roll_no TEXT NOT NULL, started_at BIGINT NOT NULL, last_at BIGINT NOT NULL, active_ms BIGINT NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS activity_sessions_roll ON activity_sessions(roll_no, started_at);
CREATE INDEX IF NOT EXISTS activity_sessions_started ON activity_sessions(started_at);
-- First time a student started a unit and finished each of its steps (kind: start | watch | play | read).
-- Only real events from deploy onward; earlier progress has no timestamps and is never back-filled.
CREATE TABLE IF NOT EXISTS unit_events (roll_no TEXT NOT NULL, unit_id TEXT NOT NULL, kind TEXT NOT NULL, at BIGINT NOT NULL, PRIMARY KEY (roll_no, unit_id, kind));
CREATE TABLE IF NOT EXISTS attempt_events (
  id          BIGSERIAL PRIMARY KEY,
  attempt_id  BIGINT NOT NULL,
  roll_no     TEXT NOT NULL,
  type        TEXT NOT NULL,      -- start, fullscreen_exit, tab_hidden, copy_attempt, … (see sprint.js PROCTOR_EVENTS)
  at          BIGINT NOT NULL,    -- client time (server-corrected)
  instance    TEXT,               -- one random id per open browser tab
  detail      TEXT,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS attempt_events_attempt ON attempt_events(attempt_id, at);
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS violations INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS proctor TEXT;   -- JSON counts: tab switches, fullscreen exits, copy attempts, windows…
-- One-time move of earlier video uploads (learning_bytes) into unit_content as the Watch step.
INSERT INTO unit_content (unit_id, slot, url, storage, file_name, size_bytes, content_type, updated_by, updated_at)
  SELECT lesson_id, 'watch', url, storage, file_name, size_bytes, content_type, updated_by, updated_at FROM learning_bytes
  ON CONFLICT (unit_id, slot) DO NOTHING;
DELETE FROM learning_bytes;

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Courses and topics (units) added by admins in Admin → Courses & topics, after the built-in ones from
-- content/units.json. Course ids are letters only; unit ids never change once students have progress.
CREATE TABLE IF NOT EXISTS content_courses (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#FFE45C', sort INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL, created_by TEXT);
CREATE TABLE IF NOT EXISTS content_units (
  id TEXT PRIMARY KEY, course TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', concept TEXT NOT NULL DEFAULT '',
  orientation TEXT NOT NULL DEFAULT 'landscape', practice_topic TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL, created_by TEXT);

-- Student photographs (small JPEG data URLs, resized in the browser). Kept out of users/registration_requests
-- so the session and approval queries stay small.
CREATE TABLE IF NOT EXISTS student_photos (roll_no TEXT PRIMARY KEY, photo TEXT NOT NULL, updated_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS request_photos (request_id BIGINT PRIMARY KEY, photo TEXT NOT NULL, created_at BIGINT NOT NULL);

-- Practice questions added in Admin → Practice questions (practiceq.js). Never deleted, only archived: the portal
-- stores MCQ answers by position.
CREATE TABLE IF NOT EXISTS practice_questions (
  id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, course TEXT NOT NULL, topic TEXT NOT NULL, data TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, updated_by TEXT);

-- Likes on the Watch videos: one per student per topic (unit).
CREATE TABLE IF NOT EXISTS unit_likes (roll_no TEXT NOT NULL, unit_id TEXT NOT NULL, course TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (roll_no, unit_id));
CREATE INDEX IF NOT EXISTS unit_likes_unit ON unit_likes(unit_id);

-- Coding practice honeypots (integrity.js): every Submit in the code editor, and the flags raised for admins.
CREATE TABLE IF NOT EXISTS practice_submissions (
  id BIGSERIAL PRIMARY KEY, roll_no TEXT NOT NULL, question_id TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '', correct INTEGER NOT NULL,
  time_ms BIGINT NOT NULL DEFAULT 0, paste_max INTEGER NOT NULL DEFAULT 0, paste_total INTEGER NOT NULL DEFAULT 0, paste_count INTEGER NOT NULL DEFAULT 0,
  code_len INTEGER NOT NULL DEFAULT 0, blurs INTEGER NOT NULL DEFAULT 0, away_ms BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS practice_submissions_q ON practice_submissions(question_id, correct);
CREATE TABLE IF NOT EXISTS integrity_flags (
  id BIGSERIAL PRIMARY KEY, roll_no TEXT NOT NULL, question_id TEXT NOT NULL, flag_type TEXT NOT NULL, evidence TEXT, created_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS integrity_flags_type ON integrity_flags(flag_type, created_at);
CREATE INDEX IF NOT EXISTS integrity_flags_roll ON integrity_flags(roll_no);
`;

// ---------- backend
let backend = null;
async function open() {
  if (config.databaseUrl) {
    const pg = (await import('pg')).default;
    pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));   // BIGINT → number (ms timestamps fit)
    pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // NUMERIC (AVG) → number
    const pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: config.dbPoolMax,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
      ssl: /sslmode=disable|localhost|127\.0\.0\.1/.test(config.databaseUrl) ? false : { rejectUnauthorized: false }
    });
    pool.on('error', (e) => console.error('[db] idle client error', e.message));
    return {
      kind: 'postgres',
      query: async (sql, params, client) => (await (client || pool).query(sql, params)).rows,
      transaction: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const r = await fn(c);
          await c.query('COMMIT');
          return r;
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          c.release();
        }
      },
      close: () => pool.end()
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = path.join(config.dataDir, 'pglite');
  const lite = await PGlite.create(config.pgliteMemory ? undefined : dir);
  return {
    kind: 'pglite',
    query: async (sql, params, client) => (await (client || lite).query(sql, params)).rows,
    exec: (sql) => lite.exec(sql),
    transaction: (fn) => lite.transaction((tx) => fn(tx)),
    close: () => lite.close()
  };
}

const txStore = new AsyncLocalStorage();
let readyPromise = null;

// Connect and create tables once per process. Safe with many serverless instances (advisory lock).
export function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      backend = await open();
      if (backend.kind === 'postgres') {
        await backend.transaction(async (c) => {
          await c.query('SELECT pg_advisory_xact_lock(72631001)');
          await c.query(SCHEMA);
        });
      } else {
        await backend.exec(SCHEMA);
      }
      return backend;
    })().catch((e) => { readyPromise = null; throw e; });
  }
  return readyPromise;
}

const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => '$' + ++i); };

export async function query(sql, params = []) {
  const b = backend || (await ready());
  return b.query(toPg(sql), params, txStore.getStore());
}
export const all = (sql, ...p) => query(sql, p);
export const one = async (sql, ...p) => (await query(sql, p))[0];
export const run = (sql, ...p) => query(sql, p);

// Runs fn inside one transaction; every one/all/run called inside it uses the same connection.
export async function tx(fn) {
  if (txStore.getStore()) return fn();
  const b = backend || (await ready());
  return b.transaction((client) => txStore.run(client, fn));
}

export async function close() { if (backend) await backend.close(); backend = null; readyPromise = null; }
export const dbKind = () => (backend ? backend.kind : config.databaseUrl ? 'postgres' : 'pglite');

// ---------- small helpers
const settingCache = new Map();
export async function getSetting(key, fallback = null) {
  const hit = settingCache.get(key);
  if (hit && Date.now() - hit.at < 5000) return hit.v ?? fallback;
  const r = await one('SELECT value FROM settings WHERE key = ?', key);
  const v = r ? JSON.parse(r.value) : null;
  settingCache.set(key, { at: Date.now(), v });
  return v ?? fallback;
}
export async function setSetting(key, value) {
  await run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  settingCache.delete(key);
}
export const clearSettingCache = () => settingCache.clear();

export async function audit(req, action, target, detail) {
  const a = req && req.admin;
  await run('INSERT INTO audit_log (admin_id, admin_email, action, target, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    a ? a.id ?? null : null, a ? a.email ?? null : null, action, target == null ? null : String(target),
    detail == null ? null : JSON.stringify(detail), req ? req.ip || null : null, Date.now());
}

export const parseJSON = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
