// Sessions (httpOnly cookies) + student OTP flows + admin password/TOTP login.
import crypto from 'node:crypto';
import { config } from './config.js';
import { one, all, run, tx, getSetting } from './db.js';
import { rateLimit } from './kv.js';
import { deliverOtp } from './otp.js';
import { randomToken, sha256, hmac, safeEqual, normRoll, validRoll, normPhone, maskPhone, verifyPassword, verifyTotp } from './security.js';

export const STUDENT_COOKIE = 'ss_session';
export const ADMIN_COOKIE = 'ss_admin';

export class AuthError extends Error {
  constructor(code, message, status = 400, extra = {}) { super(message); this.code = code; this.status = status; this.extra = extra; }
}

// ---------- cookies & sessions
export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(res, name, value, maxAgeMs) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeMs != null) bits.push('Max-Age=' + Math.max(0, Math.floor(maxAgeMs / 1000)));
  if (config.cookieSecure) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

// Per-instance cache of resolved sessions: most portal requests skip the database entirely.
// Disabling an account clears it on this instance immediately and everywhere else within SESSION_CACHE_MS.
const SESSION_CACHE_MS = 30000;
const sessionCache = new Map();
const cacheKey = (kind, hash) => kind + ':' + hash;
function cacheSet(k, v) { if (sessionCache.size > 50000) sessionCache.clear(); sessionCache.set(k, { at: Date.now(), v }); }
export function forgetSessions() { sessionCache.clear(); }

export async function createSession(req, res, kind, subjectId, { stage = 'full', ttlMs } = {}) {
  const token = randomToken(), now = Date.now();
  const ttl = ttlMs || (kind === 'admin' ? config.session.adminMs : config.session.studentMs);
  await run('INSERT INTO sessions (token_hash, kind, subject_id, stage, created_at, expires_at, last_seen_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    sha256(token), kind, subjectId, stage, now, now + ttl, now, req.ip || null, String(req.headers['user-agent'] || '').slice(0, 200));
  setCookie(res, kind === 'admin' ? ADMIN_COOKIE : STUDENT_COOKIE, token, ttl);
  return token;
}

async function readSession(req, kind) {
  const token = parseCookies(req)[kind === 'admin' ? ADMIN_COOKIE : STUDENT_COOKIE];
  if (!token) return null;
  const hash = sha256(token);
  const s = await one('SELECT * FROM sessions WHERE token_hash = ? AND kind = ?', hash, kind);
  if (!s) return null;
  const now = Date.now();
  if (s.expires_at < now) { await run('DELETE FROM sessions WHERE token_hash = ?', hash); return null; }
  if (now - s.last_seen_at > 600000) await run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', now, hash);
  return s;
}

export async function endSession(req, res, kind) {
  const name = kind === 'admin' ? ADMIN_COOKIE : STUDENT_COOKIE;
  const token = parseCookies(req)[name];
  if (token) { await run('DELETE FROM sessions WHERE token_hash = ?', sha256(token)); sessionCache.delete(cacheKey(kind, sha256(token))); }
  setCookie(res, name, '', 0);
}

export async function revokeSessions(kind, subjectId) {
  await run('DELETE FROM sessions WHERE kind = ? AND subject_id = ?', kind, subjectId);
  sessionCache.clear();
}

export async function cleanupExpired() {
  const now = Date.now();
  await run('DELETE FROM sessions WHERE expires_at < ?', now);
  await run('DELETE FROM otp_codes WHERE created_at < ?', now - 7 * 86400000);
}

export async function loadStudent(req) {
  const token = parseCookies(req)[STUDENT_COOKIE];
  if (!token) return null;
  const k = cacheKey('student', sha256(token));
  const hit = sessionCache.get(k);
  if (hit && Date.now() - hit.at < SESSION_CACHE_MS) return hit.v;
  const s = await readSession(req, 'student');
  let v = null;
  if (s) {
    const u = await one(`SELECT u.*, m.name, m.batch, m.email, m.active AS master_active FROM users u
                         JOIN students_master m ON m.roll_no = u.roll_no WHERE u.id = ?`, s.subject_id);
    if (u && u.status === 'active' && u.master_active) v = { kind: 'student', id: u.id, roll_no: u.roll_no, name: u.name, batch: u.batch, phone: u.phone };
  }
  cacheSet(k, v);
  return v;
}

// Admin sessions are never cached: every admin request is checked against the database.
export async function loadAdmin(req, { allowStage } = {}) {
  const s = await readSession(req, 'admin');
  if (!s) return null;
  if (s.stage !== 'full' && s.stage !== allowStage) return null;
  const a = await one('SELECT * FROM admins WHERE id = ?', s.subject_id);
  if (!a || a.status !== 'active') return null;
  return { kind: 'admin', id: a.id, email: a.email, name: a.name, role: a.role, stage: s.stage,
    totpEnabled: !!a.totp_enabled, mustChangePw: !!a.must_change_pw, session: s.token_hash };
}
export const adminSessionRow = (req) => readSession(req, 'admin');

// ---------- student flows
// Register:  NIAT ID + the student's OWN phone → OTP to that phone → a pending registration request.
//            An admin approves it (Admin → Approvals) before the account exists. (Setting "registration_auto_approve"
//            skips approval — only for load tests / trusted cohorts.)
// Login:     NIAT ID → OTP to the phone on the approved account.
const PURPOSES = new Set(['register', 'login']);

function checkRoll(raw) {
  const roll = normRoll(raw);
  if (!roll || !validRoll(roll)) throw new AuthError('BAD_ROLL', 'Enter a valid NIAT ID (for example N26P02A0001).');
  return roll;
}
function checkPhone(raw) {
  const phone = normPhone(raw);
  if (!phone) throw new AuthError('BAD_PHONE', 'Enter a valid 10-digit mobile number.');
  return phone;
}
async function limitOrThrow(key, limit, windowMs, message) {
  const r = await rateLimit(key, limit, windowMs);
  if (!r.ok) throw new AuthError('RATE_LIMITED', message, 429, { retryAfter: Math.ceil(r.retryAfterMs / 1000) });
}
const otpHash = (roll, purpose, phone, code) => hmac(roll + '|' + purpose + '|' + phone + '|' + code);

// Latest registration request for a NIAT ID (to tell a waiting student what is happening).
export const latestRequest = (roll) => one('SELECT * FROM registration_requests WHERE roll_no = ? ORDER BY created_at DESC LIMIT 1', roll);

async function phoneTakenBy(phone, roll) {
  const u = await one('SELECT roll_no FROM users WHERE phone = ? AND roll_no <> ?', phone, roll);
  return u ? u.roll_no : null;
}

export async function startOtp(req, purpose, rawRoll, rawPhone) {
  if (!PURPOSES.has(purpose)) throw new AuthError('BAD_REQUEST', 'Unknown request.');
  // Generous per-IP limit: a whole campus can sit behind one IP.
  await limitOrThrow('otp-ip:' + req.ip, 600, 3600000, 'Too many requests from this network. Try again later.');
  const roll = checkRoll(rawRoll);
  const m = await one('SELECT * FROM students_master WHERE roll_no = ?', roll);
  if (!m || !m.active) throw new AuthError('ROLL_NOT_FOUND', 'This NIAT ID is not in the student list. Check it, or contact your program admin.', 404);
  const u = await one('SELECT * FROM users WHERE roll_no = ?', roll);
  let phone;
  if (purpose === 'register') {
    if (u) throw new AuthError('ALREADY_REGISTERED', 'An account already exists for this NIAT ID. Log in instead.', 409);
    phone = checkPhone(rawPhone);
    if (await phoneTakenBy(phone, roll)) throw new AuthError('PHONE_IN_USE', 'This phone number is already linked to another student’s account. Use your own number.', 409);
    // Limits are per phone and per network, never per NIAT ID, so someone spamming another
    // student's NIAT ID cannot lock the real student out.
  } else {
    if (!u) {
      const r = await latestRequest(roll);
      if (r && r.status === 'pending') throw new AuthError('PENDING_APPROVAL', 'Your registration is waiting for admin approval. You can log in once it is approved.', 403);
      if (r && r.status === 'rejected') throw new AuthError('REJECTED', 'Your registration was not approved' + (r.note ? ': ' + r.note : '') + '. Register again with your own phone number, or contact your program admin.', 403);
      throw new AuthError('NOT_REGISTERED', 'No account yet for this NIAT ID. Register first.', 404);
    }
    if (u.status !== 'active') throw new AuthError('ACCOUNT_DISABLED', 'This account is disabled. Contact your program admin.', 403);
    phone = u.phone;
  }

  const now = Date.now();
  const last = await one('SELECT created_at FROM otp_codes WHERE roll_no = ? AND phone = ? ORDER BY created_at DESC LIMIT 1', roll, phone);
  if (last && now - last.created_at < config.otp.resendCooldownMs) {
    const wait = Math.ceil((config.otp.resendCooldownMs - (now - last.created_at)) / 1000);
    throw new AuthError('OTP_COOLDOWN', `Please wait ${wait}s before requesting another code.`, 429, { retryAfter: wait, maskedPhone: maskPhone(phone) });
  }
  const sent = (await one('SELECT COUNT(*) AS n FROM otp_codes WHERE phone = ? AND created_at > ?', phone, now - 3600000)).n;
  if (sent >= config.otp.maxSendsPerHour) throw new AuthError('OTP_LIMIT', 'Too many codes sent to this phone number. Try again in an hour.', 429);

  const code = String(crypto.randomInt(0, 10 ** config.otp.length)).padStart(config.otp.length, '0');
  const row = await tx(async () => {
    // Only the newest code for this NIAT ID + phone is valid.
    await run('UPDATE otp_codes SET consumed_at = ? WHERE roll_no = ? AND phone = ? AND consumed_at IS NULL', now, roll, phone);
    return one('INSERT INTO otp_codes (roll_no, purpose, phone, code_hash, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
      roll, purpose, phone, otpHash(roll, purpose, phone, code), now, now + config.otp.ttlMs, req.ip || null);
  });
  try {
    await deliverOtp(phone, code);
  } catch (e) {
    console.error('[otp] delivery failed for', roll, '-', e.message);
    await run('DELETE FROM otp_codes WHERE id = ?', row.id);
    throw new AuthError('OTP_SEND_FAILED', 'We could not send the code right now. Try again in a minute.', 502);
  }
  const out = { maskedPhone: maskPhone(phone), expiresIn: config.otp.ttlMs / 1000, resendIn: config.otp.resendCooldownMs / 1000 };
  if (config.otp.devShow) out.devOtp = code;
  return out;
}

// Returns { status: 'active', user } (signed in) or { status: 'pending' } (registration waiting for an admin).
export async function verifyOtp(req, res, purpose, rawRoll, rawCode, rawPhone) {
  if (!PURPOSES.has(purpose)) throw new AuthError('BAD_REQUEST', 'Unknown request.');
  const roll = checkRoll(rawRoll);
  const code = String(rawCode || '').replace(/\D/g, '');
  await limitOrThrow('verify-ip:' + req.ip, 1200, 3600000, 'Too many attempts from this network. Try again later.');
  // Registration codes are bound to the phone being registered; login codes to the account's phone.
  let phone;
  if (purpose === 'register') phone = checkPhone(rawPhone);
  else {
    const u0 = await one('SELECT phone FROM users WHERE roll_no = ?', roll);
    if (!u0) throw new AuthError('NOT_REGISTERED', 'No account yet for this NIAT ID. Register first.', 404);
    phone = u0.phone;
  }
  const row = await one('SELECT * FROM otp_codes WHERE roll_no = ? AND purpose = ? AND phone = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1', roll, purpose, phone);
  const now = Date.now();
  if (!row || row.expires_at < now) throw new AuthError('OTP_EXPIRED', 'This code has expired. Request a new one.', 400);
  if (row.attempts >= config.otp.maxVerifyAttempts) throw new AuthError('OTP_LOCKED', 'Too many wrong codes. Request a new one.', 429);
  if (code.length !== config.otp.length || !safeEqual(row.code_hash, otpHash(roll, purpose, phone, code))) {
    await run('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
    const left = config.otp.maxVerifyAttempts - row.attempts - 1;
    throw new AuthError('OTP_WRONG', left > 0 ? `Wrong code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Wrong code. Request a new one.', 400);
  }

  const autoApprove = purpose === 'register' && (await getSetting('registration_auto_approve', false));
  const result = await tx(async () => {
    // Consume atomically: a code can only ever be used once, even with parallel requests.
    const used = await one('UPDATE otp_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL RETURNING id', now, row.id);
    if (!used) throw new AuthError('OTP_EXPIRED', 'This code was already used. Request a new one.', 400);
    const m = await one('SELECT * FROM students_master WHERE roll_no = ?', roll);
    if (!m || !m.active) throw new AuthError('ROLL_NOT_FOUND', 'This NIAT ID is no longer in the student list.', 404);
    const u = await one('SELECT * FROM users WHERE roll_no = ?', roll);
    if (purpose === 'register') {
      if (u) throw new AuthError('ALREADY_REGISTERED', 'An account already exists for this NIAT ID. Log in instead.', 409);
      if (await phoneTakenBy(phone, roll)) throw new AuthError('PHONE_IN_USE', 'This phone number is already linked to another student’s account. Use your own number.', 409);
      // One open request per NIAT ID + phone; re-registering refreshes it.
      let reqRow = await one("SELECT * FROM registration_requests WHERE roll_no = ? AND phone = ? AND status = 'pending'", roll, phone);
      if (!reqRow) {
        reqRow = await one('INSERT INTO registration_requests (roll_no, phone, status, ip, ua, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *',
          roll, phone, 'pending', req.ip || null, String(req.headers['user-agent'] || '').slice(0, 200), now);
      }
      if (!autoApprove) return { status: 'pending' };
      const user = await approveInTx(reqRow.id, 'auto-approve');
      return { status: 'active', user };
    }
    if (!u) throw new AuthError('NOT_REGISTERED', 'No account yet for this NIAT ID. Register first.', 404);
    if (u.status !== 'active') throw new AuthError('ACCOUNT_DISABLED', 'This account is disabled. Contact your program admin.', 403);
    if (u.phone !== phone) throw new AuthError('OTP_EXPIRED', 'Your account phone number changed. Request a new code.', 400);
    return { status: 'active', user: await one('UPDATE users SET last_login_at = ? WHERE id = ? RETURNING *', now, u.id) };
  }).catch((e) => {
    if (e && e.code === '23505') throw new AuthError('ALREADY_REGISTERED', 'An account already exists for this NIAT ID. Log in instead.', 409);
    throw e;
  });
  if (result.status === 'active') await createSession(req, res, 'student', result.user.id);
  return result;
}

// ---------- admin decisions on registration requests
async function approveInTx(requestId, decidedBy) {
  const r = await one('SELECT * FROM registration_requests WHERE id = ?', requestId);
  if (!r) throw new AuthError('NOT_FOUND', 'Request not found.', 404);
  if (r.status !== 'pending') throw new AuthError('DECIDED', 'This request was already ' + r.status + '.', 409);
  const m = await one('SELECT active FROM students_master WHERE roll_no = ?', r.roll_no);
  if (!m || !m.active) throw new AuthError('ROLL_NOT_FOUND', 'This NIAT ID is no longer in the student list.', 409);
  if (await one('SELECT 1 AS x FROM users WHERE roll_no = ?', r.roll_no)) throw new AuthError('ALREADY_REGISTERED', 'This NIAT ID already has an account.', 409);
  const other = await phoneTakenBy(r.phone, r.roll_no);
  if (other) throw new AuthError('PHONE_IN_USE', 'This phone is already used by the account of ' + other + '.', 409);
  const now = Date.now();
  const user = await one('INSERT INTO users (roll_no, phone, status, created_at) VALUES (?, ?, ?, ?) RETURNING *', r.roll_no, r.phone, 'active', now);
  await run("UPDATE registration_requests SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ?", now, decidedBy, r.id);
  // Any other open requests for the same NIAT ID (e.g. someone else trying to claim it) are closed.
  await run("UPDATE registration_requests SET status = 'superseded', decided_at = ?, decided_by = ? WHERE roll_no = ? AND status = 'pending'", now, decidedBy, r.roll_no);
  return user;
}
export const approveRequest = (requestId, decidedBy) => tx(() => approveInTx(requestId, decidedBy));

export async function rejectRequest(requestId, decidedBy, note) {
  const r = await one("UPDATE registration_requests SET status = 'rejected', note = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending' RETURNING *",
    note ? String(note).slice(0, 300) : null, Date.now(), decidedBy, requestId);
  if (!r) throw new AuthError('DECIDED', 'This request is no longer pending.', 409);
  return r;
}

// Admin: change the phone an approved account logs in with (e.g. the student lost their SIM).
export async function changeAccountPhone(roll, rawPhone) {
  const phone = checkPhone(rawPhone);
  const u = await one('SELECT * FROM users WHERE roll_no = ?', roll);
  if (!u) throw new AuthError('NOT_FOUND', 'This student has no account.', 404);
  const other = await phoneTakenBy(phone, roll);
  if (other) throw new AuthError('PHONE_IN_USE', 'This phone is already used by the account of ' + other + '.', 409);
  await run('UPDATE users SET phone = ? WHERE id = ?', phone, u.id);
  await revokeSessions('student', u.id);
  return { before: u.phone, after: phone };
}

// ---------- admin login: password, then authenticator code (or first-time enrolment)
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==';

export async function adminPasswordLogin(req, res, rawEmail, password) {
  const email = String(rawEmail || '').trim().toLowerCase();
  await limitOrThrow('admin-ip:' + req.ip, 20, 900000, 'Too many login attempts. Try again in 15 minutes.');
  const a = await one('SELECT * FROM admins WHERE email = ?', email);
  const now = Date.now();
  if (a && a.locked_until > now) throw new AuthError('LOCKED', 'Account temporarily locked after failed attempts. Try again later.', 429);
  const ok = verifyPassword(String(password || ''), a ? a.password_hash : DUMMY_HASH);
  if (!a || !ok || a.status !== 'active') {
    if (a) {
      const fails = a.failed_logins + 1, lock = fails >= config.admin.maxFailedLogins;
      await run('UPDATE admins SET failed_logins = ?, locked_until = ? WHERE id = ?', lock ? 0 : fails, lock ? now + config.admin.lockMs : 0, a.id);
    }
    throw new AuthError('BAD_LOGIN', 'Wrong email or password.', 401);
  }
  await run('UPDATE admins SET failed_logins = 0, locked_until = 0 WHERE id = ?', a.id);
  if (a.totp_enabled) { await createSession(req, res, 'admin', a.id, { stage: 'totp', ttlMs: 5 * 60000 }); return { next: 'totp' }; }
  if (config.admin.requireTotp) { await createSession(req, res, 'admin', a.id, { stage: 'setup', ttlMs: 15 * 60000 }); return { next: 'setup' }; }
  await run('UPDATE admins SET last_login_at = ? WHERE id = ?', now, a.id);
  await createSession(req, res, 'admin', a.id);
  return { next: 'done' };
}

export async function adminTotpLogin(req, res, code) {
  const s = await readSession(req, 'admin');
  if (!s || s.stage !== 'totp') throw new AuthError('SESSION', 'Your login expired. Start again.', 401);
  await limitOrThrow('admin-totp:' + s.subject_id, 10, 900000, 'Too many attempts. Try again in 15 minutes.');
  const a = await one('SELECT * FROM admins WHERE id = ?', s.subject_id);
  const step = a && a.status === 'active' ? verifyTotp(a.totp_secret, code, a.totp_last_step) : 0;
  if (!step) throw new AuthError('BAD_CODE', 'Wrong or expired authenticator code.', 401);
  await run('UPDATE admins SET totp_last_step = ?, last_login_at = ? WHERE id = ?', step, Date.now(), a.id);
  await run('DELETE FROM sessions WHERE token_hash = ?', s.token_hash);
  await createSession(req, res, 'admin', a.id);
}

export async function finishTotpSetup(req, res, code) {
  const s = await readSession(req, 'admin');
  if (!s || (s.stage !== 'setup' && s.stage !== 'full')) throw new AuthError('SESSION', 'Your login expired. Start again.', 401);
  const a = await one('SELECT * FROM admins WHERE id = ?', s.subject_id);
  if (!a || !a.totp_secret) throw new AuthError('NO_SECRET', 'Start the authenticator setup first.', 400);
  const step = verifyTotp(a.totp_secret, code, a.totp_last_step);
  if (!step) throw new AuthError('BAD_CODE', 'That code did not match. Check the time on your phone and try again.', 401);
  await run('UPDATE admins SET totp_enabled = 1, totp_last_step = ?, last_login_at = ? WHERE id = ?', step, Date.now(), a.id);
  await run('DELETE FROM sessions WHERE token_hash = ?', s.token_hash);
  await createSession(req, res, 'admin', a.id);
  return { id: a.id, email: a.email };
}

export const listSessions = (kind, id) => all('SELECT created_at, last_seen_at, ip, ua FROM sessions WHERE kind = ? AND subject_id = ?', kind, id);
