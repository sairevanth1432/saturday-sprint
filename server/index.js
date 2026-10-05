// Saturday Sprint server: student API, admin API (and, when run locally, the pages).
// On Vercel this Express app runs as one auto-scaling function (api/index.js); pages come from the CDN (public/).
import path from 'node:path';
import fs from 'node:fs';
import cluster from 'node:cluster';
import express from 'express';
import compression from 'compression';
import QRCode from 'qrcode';
import { config, ROOT } from './config.js';
import { ready, one, all, run, tx, audit, getSetting, setSetting, clearSettingCache, parseJSON, dbKind } from './db.js';
import * as kv from './kv.js';
import {
  AuthError, loadStudent, loadAdmin, adminSessionRow, startOtp, verifyOtp, endSession, revokeSessions, cleanupExpired,
  approveRequest, rejectRequest, changeAccountPhone, passwordLogin, setStudentPassword, resetStudentPassword, nameLogin, loginMode,
  adminPasswordLogin, adminTotpLogin, finishTotpSetup, listSessions, forgetSessions
} from './auth.js';
import { normRoll, validRoll, normPhone, maskPhone, hashPassword, verifyPassword, passwordProblem, generatePassword, newTotpSecret, otpauthUri } from './security.js';
import { readStudents, rowsFrom, importStudents, syncStudentsFile, watchStudentsFile, studentsFilePath, studentCounts, logImport } from './students.js';
import {
  SprintError, getSprint, sprintFor, setPreviewSprint, restartPreview, getQuestions, builtinQuestions, questionTypes, maxTotal, getAttempt, attemptView, resultView, startAttempt, saveDraft, checkCode,
  submitAttempt, finalizeExpired, setTextMarks, leaderboard, leaderboardRows, clearBoardCache, readDraft, MARKS, RANK_RULE
} from './sprint.js';
import { unitContentMap, packUnits, catalog, setContent, setHtmlContent, htmlContent, removeContent, blobEnabled, isBlobUrl, isS3Url, s3Enabled, storageKind, presignUpload, lessonIds, SLOTS, typesFor, maxBytesFor, extFor, parseClientPayload, clearContentCache } from './media.js';
import { startGrader, stopGrader } from './grader.js';
import { practiceAnalytics, practiceQuestion, practiceCounts } from './practice.js';
import { recordActivity, recordStepEvents, businessMetrics, overview as analyticsOverview, studentRows, studentDetail } from './analytics.js';
import { listSprints, listQuestions, addQuestion, updateQuestion, deleteQuestion, reorderQuestions, copyQuestions, reviewMode, setReviewMode, reviewFor } from './questions.js';
import { proctorSettings, recordEvents, attemptEvents, proctorView, VIOLATIONS } from './proctor.js';

const PUBLIC = path.join(ROOT, 'public');
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);
// gzip/brotli-free compression for HTML/JS/JSON (the 1.8 MB portal page becomes ~0.4 MB). Videos are left alone.
app.use(compression({ threshold: 1024 }));

app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' });
  next();
});

// Local video upload streams the raw body; everything else is JSON.
const LOCAL_UPLOAD = /^\/api\/admin\/media\/[^/]+\/(watch|play|read)\/local$/;
app.use((req, res, next) => (LOCAL_UPLOAD.test(req.path) ? next() : express.json({ limit: '4mb' })(req, res, next)));

// CSRF defence: state-changing requests must come from this site (cookies are also SameSite=Lax).
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch {}
    if (host !== req.headers.host) return res.status(403).json({ error: 'BAD_ORIGIN', message: 'Cross-site request blocked.' });
  }
  if (!LOCAL_UPLOAD.test(req.path) && Number(req.headers['content-length'] || 0) > 0 && !req.is('application/json'))
    return res.status(415).json({ error: 'JSON_ONLY', message: 'Send JSON.' });
  next();
});

// Connect to the database (and create tables) on first use in each instance.
app.use(async (req, res, next) => { await ready(); next(); });

const noStore = (res) => res.set('Cache-Control', 'no-store');

// ===================================================================== pages (local server; on Vercel the CDN serves public/)
const sendPage = (file) => (req, res) => { noStore(res); res.sendFile(path.join(PUBLIC, file)); };
app.get('/', async (req, res) => {
  if (!(await loadStudent(req)) && !(await loadAdmin(req))) return res.redirect('/login');
  if (!fs.existsSync(path.join(PUBLIC, 'portal.html'))) return res.status(503).send('Portal not built yet. Run: npm run build');
  sendPage('portal.html')(req, res);
});
app.get('/login', async (req, res) => ((await loadStudent(req)) ? res.redirect('/') : sendPage('login.html')(req, res)));
app.get('/admin', sendPage('admin.html'));
app.get('/help', sendPage('help.html'));
app.get('/review', sendPage('review.html'));
app.get('/portal.html', (req, res) => res.redirect('/'));
app.get('/favicon.ico', (req, res) => res.status(204).end()); // no icon yet; avoids a 404 in every browser console
// Admin-uploaded HTML (Play/Read steps) runs in a sandbox: it can run its own scripts but gets an opaque origin,
// so it cannot use the student's session or call this site's API. (It also cannot keep data in localStorage.)
app.use('/uploads', express.static(config.localUploadsDir, { index: false, fallthrough: false, setHeaders: (res, p) => {
  if (/\.html?$/i.test(p)) res.set('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads');
} }));
app.use(express.static(PUBLIC, { index: false, extensions: [], setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

// ===================================================================== student API
const api = express.Router();
app.use('/api', api);

api.get('/health', async (req, res) => {
  noStore(res);
  await one('SELECT 1 AS ok');
  res.json({ ok: true, db: dbKind(), redis: kv.kvKind, storage: storageKind(), region: process.env.VERCEL_REGION || 'self-hosted', pid: process.pid });
});

api.post('/auth/:purpose/start', async (req, res) => res.json(await startOtp(req, req.params.purpose, req.body && req.body.rollNo, req.body && req.body.phone)));
api.post('/auth/:purpose/verify', async (req, res) => {
  const b = req.body || {};
  const r = await verifyOtp(req, res, req.params.purpose, b.rollNo, b.otp, b.phone, b.password);
  res.json(r.status === 'pending' ? { ok: true, status: 'pending' } : { ok: true, status: 'active', rollNo: r.user.roll_no, hasPassword: !!r.hasPassword });
});
// NIAT ID + password (no OTP needed after the password is set).
// Initial roll-out: NIAT ID + name from the student list (setting student_login_mode = "simple").
api.post('/auth/name-login', async (req, res) => {
  const u = await nameLogin(req, res, req.body && req.body.rollNo, req.body && req.body.name);
  res.json({ ok: true, rollNo: u.roll_no });
});
api.post('/auth/password-login', async (req, res) => {
  const u = await passwordLogin(req, res, req.body && req.body.rollNo, req.body && req.body.password);
  res.json({ ok: true, rollNo: u.roll_no });
});
// Set / change the logged-in student's password (current password, or within 15 min of an OTP login).
api.post('/auth/password', async (req, res) => {
  await setStudentPassword(req, req.body && req.body.password, req.body && req.body.current);
  res.json({ ok: true });
});
api.post('/auth/logout', async (req, res) => { await endSession(req, res, 'student'); res.json({ ok: true }); });

async function who(req, res, next) {
  req.who = (await loadStudent(req)) || (await loadAdmin(req));
  if (!req.who) return res.status(401).json({ error: 'AUTH', message: 'Please log in.' });
  next();
}

api.get('/me', who, (req, res) => {
  const w = req.who;
  res.json(w.kind === 'student' ? { kind: 'student', rollNo: w.roll_no, name: w.name, batch: w.batch, phone: maskPhone(w.phone), hasPassword: !!w.hasPassword }
    : { kind: 'admin', name: w.name, email: w.email, role: w.role });
});

// Public facts for the Help page and the landing page (no login): Sprint window, format, rules and the units it is based on.
api.get('/info', async (req, res) => {
  const [sprint, proctor, mode] = await Promise.all([getSprint(), proctorSettings(), loginMode()]);
  const qs = await getQuestions(sprint.id), byCourse = {};
  qs.forEach((q) => { byCourse[q.course] = (byCourse[q.course] || 0) + 1; });
  res.set('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  res.json({
    sprint: { title: sprint.title, openMs: sprint.openMs, closeMs: sprint.closeMs, durationMin: sprint.durationMin, questions: qs.length, byCourse,
      types: [...new Set(qs.map((q) => q.type))], leaderboardVisible: sprint.leaderboardVisible },
    proctor,
    loginMode: mode,
    units: (packUnits().units || []).map((u) => ({ course: u.course, title: u.name || u.title })),
    practice: practiceCounts(),
    serverNow: Date.now()
  });
});

api.get('/bootstrap', who, async (req, res) => {
  noStore(res);
  const w = req.who, sprint = await sprintFor(w);
  const [a, prog, fb, bytes, proctor] = await Promise.all([
    getAttempt(w, sprint),
    w.kind === 'student' ? one('SELECT data FROM progress WHERE roll_no = ?', w.roll_no) : null,
    w.kind === 'student' ? one("SELECT 1 AS x FROM feedback WHERE roll_no = ? AND kind = 'sprint-test' LIMIT 1", w.roll_no) : null,
    unitContentMap(),
    proctorSettings()
  ]);
  res.json({
    serverNow: Date.now(),
    user: w.kind === 'student' ? { kind: 'student', rollNo: w.roll_no, name: w.name, batch: w.batch }
      : { kind: 'admin', name: w.name || w.email, email: w.email, role: w.role },
    sprint: { id: sprint.id, title: sprint.title, openMs: sprint.openMs, closeMs: sprint.closeMs, durMs: sprint.durMs,
      preview: w.kind === 'admin', leaderboard: sprint.leaderboardVisible, types: await questionTypes(sprint.id), proctor, reviewMode: await reviewMode(sprint.id), previewOf: sprint.previewOf || null },
    violations: a && a.status === 'running' ? a.violations || 0 : 0,
    attempt: await attemptView(a, { withQuestions: true }),
    testFeedbackDone: !!fb,
    progress: prog ? parseJSON(prog.data, {}) : {},
    unitContent: bytes,
    units: packUnits()
  });
});

api.post('/sprint/start', who, async (req, res) => {
  const a = await startAttempt(req.who);
  res.json({ serverNow: Date.now(), attempt: await attemptView(a, { withQuestions: true }) });
});
api.put('/sprint/draft', who, async (req, res) => { await saveDraft(req.who, req.body); res.json({ ok: true, serverNow: Date.now() }); });
api.post('/sprint/check', who, async (req, res) => {
  const key = 'check:' + (req.who.kind === 'admin' ? 'A' + req.who.id : req.who.roll_no);
  if (!(await kv.rateLimit(key, 12, 60000)).ok) throw new SprintError('RATE_LIMITED', 'Too many checks. Wait a few seconds.', 429);
  res.json({ results: await checkCode(req.who, Number(req.body.index), req.body.code) });
});
// Proctoring activity from the test page (batched). Over the violation limit the attempt is submitted here.
api.post('/sprint/events', who, async (req, res) => {
  const key = 'events:' + (req.who.kind === 'admin' ? 'A' + req.who.id : req.who.roll_no);
  if (!(await kv.rateLimit(key, 60, 60000)).ok) return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many reports.' });
  const r = await recordEvents(req.who, req.body);
  if (r.attempt) clearBoardCacheSoon();
  res.json({ ...r, attempt: r.attempt ? await attemptView(r.attempt) : undefined, serverNow: Date.now() });
});
// Portal activity (time and clicks per area / unit / step), batched by the browser every ~2 minutes.
api.post('/activity', who, async (req, res) => {
  if (req.who.kind === 'student' && !(await kv.rateLimit('act:' + req.who.roll_no, 20, 60000)).ok) return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many reports.' });
  res.json(await recordActivity(req.who, req.body));
});
// Answers review after the test (when Sprint settings allow it for that Sprint)
api.get('/sprint/review', who, async (req, res) => {
  noStore(res);
  res.json(await reviewFor(req.who, req.query.sprint ? String(req.query.sprint) : null));
});
// Admin preview: start the test again from scratch
api.post('/sprint/restart', who, async (req, res) => {
  await restartPreview(req.who);
  res.json({ ok: true });
});
api.post('/sprint/submit', who, async (req, res) => {
  const a = await submitAttempt(req.who, req.body);
  if (a.status === 'submitted') clearBoardCacheSoon();
  res.json({ serverNow: Date.now(), attempt: await attemptView(a) });
});

// At 15k submissions the board is invalidated at most once per 5 s, not once per submission.
let boardDirty = null;
function clearBoardCacheSoon() {
  if (boardDirty) return;
  boardDirty = setTimeout(() => { boardDirty = null; clearBoardCache().catch(() => {}); }, 5000);
  boardDirty.unref?.();
}

// Auto-submit sweep, throttled to one instance every 20 s (in addition to the per-minute cron).
async function maybeFinalize() {
  if (await kv.setNX('lock:finalize', '1', 20)) await finalizeExpired({ limit: 50, budgetMs: 5000 }).catch((e) => console.error('[sprint]', e.message));
}

api.get('/leaderboard', who, async (req, res) => {
  noStore(res);
  const sprint = await getSprint();
  if (!sprint.leaderboardVisible && req.who.kind !== 'admin') return res.json({ hidden: true, rows: [], me: null, rule: RANK_RULE, participants: 0 });
  await maybeFinalize();
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  res.json(await leaderboard(req.who.kind === 'student' ? req.who.roll_no : null, limit));
});

api.put('/progress', who, async (req, res) => {
  if (req.who.kind !== 'student') return res.json({ ok: true, skipped: true });
  const data = JSON.stringify((req.body && req.body.data) || {});
  if (data.length > 500000) return res.status(413).json({ error: 'TOO_LARGE', message: 'Progress too large.' });
  // Record steps that just got their ✓ (for time-to-completion). Reads the old progress only; the progress below is stored exactly as sent.
  const before = await one('SELECT data FROM progress WHERE roll_no = ?', req.who.roll_no);
  await recordStepEvents(req.who.roll_no, before ? before.data : null, (req.body && req.body.data) || {}).catch((e) => console.error('[progress] step events', e.message));
  await run('INSERT INTO progress (roll_no, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (roll_no) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
    req.who.roll_no, data, Date.now());
  res.json({ ok: true });
});

api.post('/feedback', who, async (req, res) => {
  if (req.who.kind !== 'student') return res.json({ ok: true, skipped: true });
  if (!(await kv.rateLimit('fb:' + req.who.roll_no, 20, 3600000)).ok) throw new SprintError('RATE_LIMITED', 'Too much feedback at once.', 429);
  const b = req.body || {};
  await run('INSERT INTO feedback (roll_no, kind, rating, text, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    req.who.roll_no, String(b.kind || 'portal').slice(0, 40), Math.max(0, Math.min(5, Number(b.rating) || 0)), String(b.text || '').slice(0, 5000),
    JSON.stringify({ tab: b.tab, course: b.course }), Date.now());
  res.json({ ok: true });
});

// Play/Read HTML uploaded by admins, served from the database. Sandboxed (opaque origin: no access to the
// student's session or this site's API) and cacheable by the CDN, because the URL changes on every update.
api.get('/content/:unitId/:slot', async (req, res) => {
  const { unitId, slot } = req.params;
  if (!['play', 'read'].includes(slot)) return res.status(404).end();
  const r = await htmlContent(unitId, slot);
  if (!r) return res.status(404).type('text/plain').send('Not found');
  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads',
    'Cache-Control': req.query.v ? 'public, max-age=300, s-maxage=31536000, immutable' : 'public, max-age=60, s-maxage=60',
    'X-Frame-Options': 'SAMEORIGIN'
  });
  res.send(r.body);
});

// Vercel Cron (vercel.json) calls this every minute with "Authorization: Bearer $CRON_SECRET".
api.get('/cron/finalize', async (req, res) => {
  if (!config.cronSecret || req.headers.authorization !== 'Bearer ' + config.cronSecret) return res.status(401).json({ error: 'AUTH' });
  const done = await finalizeExpired({ limit: 2000, budgetMs: 240000 });
  if (new Date().getUTCMinutes() === 0) await cleanupExpired();
  res.json({ ok: true, autoSubmitted: done });
});

// ===================================================================== admin auth
const adm = express.Router();
api.use('/admin', adm);

adm.post('/login', async (req, res) => res.json(await adminPasswordLogin(req, res, req.body.email, req.body.password)));
adm.post('/login/totp', async (req, res) => { await adminTotpLogin(req, res, req.body.code); res.json({ ok: true }); });
adm.post('/logout', async (req, res) => { await endSession(req, res, 'admin'); res.json({ ok: true }); });

adm.get('/totp/setup', async (req, res) => {
  const a = await loadAdmin(req, { allowStage: 'setup' });
  if (!a) throw new AuthError('AUTH', 'Please log in.', 401);
  const row = await one('SELECT totp_secret, totp_enabled FROM admins WHERE id = ?', a.id);
  if (row.totp_enabled) throw new AuthError('ALREADY', 'Authenticator already set up.', 409);
  let secret = row.totp_secret;
  if (!secret) { secret = newTotpSecret(); await run('UPDATE admins SET totp_secret = ? WHERE id = ?', secret, a.id); }
  noStore(res);
  const uri = otpauthUri(secret, a.email);
  res.json({ secret, uri, qrSvg: await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) });
});
adm.post('/totp/enable', async (req, res) => {
  const a = await finishTotpSetup(req, res, req.body.code);
  await audit({ admin: a, ip: req.ip }, 'admin.totp_enabled', a.email, null);
  res.json({ ok: true });
});

async function requireAdmin(req, res, next) {
  const a = await loadAdmin(req);
  if (!a) return res.status(401).json({ error: 'AUTH', message: 'Please log in.' });
  req.admin = a;
  next();
}
const requireSuper = (req, res, next) => (req.admin.role === 'super_admin' ? next()
  : res.status(403).json({ error: 'FORBIDDEN', message: 'Super admin only.' }));

adm.get('/me', requireAdmin, (req, res) => {
  const a = req.admin;
  res.json({ id: a.id, email: a.email, name: a.name, role: a.role, mustChangePw: a.mustChangePw, totpEnabled: a.totpEnabled, totpRequired: config.admin.requireTotp });
});

adm.post('/password', requireAdmin, async (req, res) => {
  const row = await one('SELECT password_hash FROM admins WHERE id = ?', req.admin.id);
  if (!verifyPassword(String(req.body.current || ''), row.password_hash)) throw new AuthError('BAD_LOGIN', 'Current password is wrong.', 400);
  const p = passwordProblem(req.body.next);
  if (p) throw new AuthError('WEAK_PASSWORD', p, 400);
  await run('UPDATE admins SET password_hash = ?, must_change_pw = 0 WHERE id = ?', hashPassword(req.body.next), req.admin.id);
  await run("DELETE FROM sessions WHERE kind = 'admin' AND subject_id = ? AND token_hash != ?", req.admin.id, req.admin.session);
  await audit(req, 'admin.password_changed', req.admin.email);
  res.json({ ok: true });
});

// Vercel Blob client upload: the browser asks for an upload token here, then sends the file straight to Blob
// (no 4.5 MB function limit). Vercel Blob also calls this route when the upload completes.
adm.post('/media/blob-upload', async (req, res) => {
  if (!blobEnabled()) return res.status(400).json({ error: 'NO_BLOB', message: 'Vercel Blob is not connected (BLOB_READ_WRITE_TOKEN missing).' });
  const { handleUpload } = await import('@vercel/blob/client');
  try {
    const out = await handleUpload({
      body: req.body, request: req, token: config.blobToken,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const a = await loadAdmin(req);
        if (!a) throw new Error('Not authenticated');
        const { lessonId, slot } = parseClientPayload(clientPayload);
        if (!lessonIds().has(lessonId) || !SLOTS.includes(slot)) throw new Error('Unknown unit or step');
        return { allowedContentTypes: typesFor(slot), maximumSizeInBytes: maxBytesFor(slot), addRandomSuffix: true,
          tokenPayload: JSON.stringify({ lessonId, slot, admin: a.email }) };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const p = parseClientPayload(tokenPayload);
        if (lessonIds().has(p.lessonId) && SLOTS.includes(p.slot)) await setContent(p.lessonId, p.slot, { url: blob.url, storage: 'blob', fileName: blob.pathname, contentType: blob.contentType, by: p.admin });
      }
    });
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: 'UPLOAD', message: e.message });
  }
});

// ===================================================================== admin data
adm.use(requireAdmin);

adm.get('/overview', async (req, res) => {
  await maybeFinalize();
  const sprint = await getSprint();
  const [att, lastImport, counts, recentUsers, top] = await Promise.all([
    one(`SELECT COUNT(*) FILTER (WHERE status = 'running') AS running, COUNT(*) FILTER (WHERE status = 'submitted') AS submitted,
        AVG(total) FILTER (WHERE status = 'submitted') AS avg_total, MAX(total) AS best,
        COUNT(*) FILTER (WHERE status = 'submitted' AND text_reviewed = 0) AS pending_review
      FROM attempts WHERE sprint_id = ? AND roll_no NOT LIKE 'ADMIN-%'`, sprint.id),
    one('SELECT * FROM imports ORDER BY id DESC LIMIT 1'),
    studentCounts(),
    all('SELECT u.roll_no, m.name, u.created_at FROM users u JOIN students_master m ON m.roll_no = u.roll_no ORDER BY u.created_at DESC LIMIT 8'),
    leaderboardRows(sprint.id, 5)
  ]);
  const pendingApprovals = (await one("SELECT COUNT(*) AS n FROM registration_requests WHERE status = 'pending'")).n;
  res.json({
    serverNow: Date.now(), sprint, counts, attempts: att, maxTotal: await maxTotal(sprint.id), pendingApprovals,
    lastImport: lastImport && { ...lastImport, errors: parseJSON(lastImport.errors, {}) },
    studentsFile: config.isVercel ? null : studentsFilePath(), studentsFileExists: !config.isVercel && fs.existsSync(studentsFilePath()),
    recentUsers, top: top.map((r) => ({ rank: r.rank, roll_no: r.roll_no, name: r.name, total: r.total, max_total: r.max_total, used_ms: r.used_ms })),
    otpProvider: config.otp.provider, testOtp: config.otp.devShow,
    infra: { db: dbKind(), redis: kv.kvShared, redisKind: kv.kvKind, blob: storageKind() !== 'none' && storageKind() !== 'local', storage: storageKind(), vercel: config.isVercel, region: process.env.VERCEL_REGION || null, processes: config.webConcurrency }
  });
});

const progressSummary = (data) => {
  const d = parseJSON(data, {}) || {};
  const count = (o) => Object.values(o || {}).filter(Boolean).length;
  return { lessons: count(d.done), practice: Object.keys(d.pPick || {}).length, solved: count(d.solved) };
};

adm.get('/students', async (req, res) => {
  const sprint = await getSprint();
  const q = String(req.query.q || '').trim();
  const filter = String(req.query.filter || 'all');
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100)), offset = Math.max(0, Number(req.query.offset) || 0);
  const where = [], p = [sprint.id];
  if (q) { where.push('(m.roll_no ILIKE ? OR m.name ILIKE ? OR m.phone ILIKE ? OR m.batch ILIKE ? OR m.email ILIKE ?)'); const l = '%' + q + '%'; p.push(l, l, l, l, l); }
  if (filter === 'registered') where.push('u.id IS NOT NULL');
  if (filter === 'unregistered') where.push('u.id IS NULL AND m.active = 1');
  if (filter === 'pending') where.push("u.id IS NULL AND m.roll_no IN (SELECT roll_no FROM registration_requests WHERE status = 'pending')");
  if (filter === 'disabled') where.push("u.status = 'disabled'");
  if (filter === 'inactive') where.push('m.active = 0');
  if (filter === 'submitted') where.push("a.status = 'submitted'");
  if (filter === 'not_submitted') where.push("u.id IS NOT NULL AND (a.id IS NULL OR a.status != 'submitted')");
  const sql = `FROM students_master m LEFT JOIN users u ON u.roll_no = m.roll_no
    LEFT JOIN attempts a ON a.roll_no = m.roll_no AND a.sprint_id = ? LEFT JOIN progress pr ON pr.roll_no = m.roll_no
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  const [cnt, rows] = await Promise.all([
    one('SELECT COUNT(*) AS n ' + sql, ...p),
    all(`SELECT m.*, u.id AS user_id, u.status AS user_status, u.created_at AS registered_at, u.last_login_at, (u.password_hash IS NOT NULL) AS has_password,
        a.id AS attempt_id, a.status AS attempt_status, a.total, a.max_total, a.used_ms, pr.data AS progress ${sql}
        ORDER BY m.roll_no LIMIT ? OFFSET ?`, ...p, limit, offset)
  ]);
  res.json({ total: cnt.n, rows: rows.map(({ progress, ...r }) => ({ ...r, progress: progressSummary(progress) })) });
});

adm.get('/students/:roll', async (req, res) => {
  const roll = normRoll(req.params.roll);
  const m = await one('SELECT * FROM students_master WHERE roll_no = ?', roll);
  if (!m) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such NIAT ID.' });
  const u = await one('SELECT * FROM users WHERE roll_no = ?', roll);
  const [attempts, pr, feedback, sessions, otps] = await Promise.all([
    all('SELECT id, sprint_id, status, started_at, deadline_at, submitted_at, auto_submitted, total, max_total, used_ms, text_reviewed FROM attempts WHERE roll_no = ? ORDER BY started_at DESC', roll),
    one('SELECT * FROM progress WHERE roll_no = ?', roll),
    all('SELECT kind, rating, text, created_at FROM feedback WHERE roll_no = ? ORDER BY id DESC LIMIT 50', roll),
    u ? listSessions('student', u.id) : [],
    all('SELECT purpose, created_at, expires_at, consumed_at, attempts FROM otp_codes WHERE roll_no = ? ORDER BY id DESC LIMIT 10', roll)
  ]);
  const requests = await all('SELECT id, phone, status, note, created_at, decided_at, decided_by FROM registration_requests WHERE roll_no = ? ORDER BY created_at DESC LIMIT 20', roll);
  if (u) { u.has_password = !!u.password_hash; delete u.password_hash; }
  res.json({ master: m, user: u, attempts, progress: pr ? { ...progressSummary(pr.data), updated_at: pr.updated_at, data: parseJSON(pr.data, {}) } : null, feedback, sessions, otps, requests });
});

function cleanStudent(b, roll) {
  // The sheet phone is optional (students register their own number); if given, it must be valid.
  const phone = b.phone ? normPhone(b.phone) : '';
  if (b.phone && !phone) throw new AuthError('BAD_PHONE', 'Enter a valid phone number, or leave it empty.', 400);
  return { roll_no: roll, name: String(b.name || '').trim().slice(0, 120), phone,
    batch: String(b.batch || '').trim().slice(0, 80), email: String(b.email || '').trim().toLowerCase().slice(0, 160) };
}

adm.post('/students', async (req, res) => {
  const roll = normRoll(req.body.roll_no);
  if (!validRoll(roll)) throw new AuthError('BAD_ROLL', 'Enter a valid NIAT ID.', 400);
  if (await one('SELECT 1 AS x FROM students_master WHERE roll_no = ?', roll)) throw new AuthError('EXISTS', 'That NIAT ID already exists.', 409);
  const s = cleanStudent(req.body, roll);
  await run("INSERT INTO students_master (roll_no, name, phone, batch, email, active, source, updated_at) VALUES (?, ?, ?, ?, ?, 1, 'admin', ?)",
    s.roll_no, s.name, s.phone, s.batch, s.email, Date.now());
  await audit(req, 'student.created', roll, s);
  res.json({ ok: true });
});

adm.patch('/students/:roll', async (req, res) => {
  const roll = normRoll(req.params.roll);
  const m = await one('SELECT * FROM students_master WHERE roll_no = ?', roll);
  if (!m) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such NIAT ID.' });
  const s = cleanStudent({ ...m, ...req.body }, roll);
  const active = req.body.active === undefined ? m.active : (req.body.active ? 1 : 0);
  await run('UPDATE students_master SET name = ?, phone = ?, batch = ?, email = ?, active = ?, updated_at = ? WHERE roll_no = ?',
    s.name, s.phone, s.batch, s.email, active, Date.now(), roll);
  if (!active) { const u = await one('SELECT id FROM users WHERE roll_no = ?', roll); if (u) await revokeSessions('student', u.id); }
  await clearBoardCache();
  await audit(req, 'student.updated', roll, { before: { name: m.name, phone: m.phone, batch: m.batch, email: m.email, active: m.active }, after: { ...s, active } });
  res.json({ ok: true });
});

adm.post('/users/:roll/status', async (req, res) => {
  const roll = normRoll(req.params.roll), status = req.body.status === 'disabled' ? 'disabled' : 'active';
  const u = await one('SELECT * FROM users WHERE roll_no = ?', roll);
  if (!u) return res.status(404).json({ error: 'NOT_FOUND', message: 'This student has not registered.' });
  await run('UPDATE users SET status = ? WHERE id = ?', status, u.id);
  if (status === 'disabled') await revokeSessions('student', u.id);
  forgetSessions();
  await clearBoardCache();
  await audit(req, status === 'disabled' ? 'user.disabled' : 'user.enabled', roll);
  res.json({ ok: true });
});

// ---------- registration approvals
adm.get('/approvals', async (req, res) => {
  const status = ['pending', 'approved', 'rejected', 'superseded'].includes(req.query.status) ? req.query.status : 'pending';
  const rows = await all(`SELECT r.*, m.name, m.phone AS sheet_phone, m.email, m.batch, m.active,
      (SELECT COUNT(*) FROM registration_requests r2 WHERE r2.roll_no = r.roll_no AND r2.status = 'pending' AND r2.id <> r.id) AS other_requests_same_id,
      (SELECT COUNT(*) FROM registration_requests r3 WHERE r3.phone = r.phone AND r3.roll_no <> r.roll_no AND r3.status IN ('pending', 'approved')) AS phone_used_for_other_ids,
      (SELECT u.roll_no FROM users u WHERE u.roll_no = r.roll_no) AS has_account
    FROM registration_requests r LEFT JOIN students_master m ON m.roll_no = r.roll_no
    WHERE r.status = ? ORDER BY r.created_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 2000`, status);
  res.json({ rows: rows.map((r) => ({ ...r, matches_sheet: !!r.sheet_phone && r.sheet_phone === r.phone })),
    counts: await one(`SELECT COUNT(*) FILTER (WHERE status = 'pending') AS pending, COUNT(*) FILTER (WHERE status = 'approved') AS approved,
      COUNT(*) FILTER (WHERE status = 'rejected') AS rejected FROM registration_requests`) });
});
// body: { ids: [..], action: 'approve' | 'reject', note? }  — each id is decided on its own; failures are reported, not fatal.
adm.post('/approvals/decide', async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isFinite).slice(0, 2000) : [];
  const action = req.body.action === 'reject' ? 'reject' : 'approve';
  const done = [], failed = [];
  for (const id of ids) {
    try {
      if (action === 'approve') { const u = await approveRequest(id, req.admin.email); done.push({ id, roll_no: u.roll_no }); }
      else { const r = await rejectRequest(id, req.admin.email, req.body.note); done.push({ id, roll_no: r.roll_no }); }
    } catch (e) { failed.push({ id, error: e.message }); }
  }
  if (done.length) await audit(req, action === 'approve' ? 'registration.approved' : 'registration.rejected', done.map((d) => d.roll_no).slice(0, 50).join(','),
    { count: done.length, note: req.body.note || null, ids: done.map((d) => d.id) });
  res.json({ ok: true, done: done.length, failed });
});
adm.patch('/users/:roll/phone', async (req, res) => {
  const roll = normRoll(req.params.roll);
  const r = await changeAccountPhone(roll, req.body.phone);
  forgetSessions();
  await audit(req, 'user.phone_changed', roll, r);
  res.json({ ok: true });
});

adm.post('/users/:roll/password-reset', async (req, res) => {
  const roll = normRoll(req.params.roll);
  await resetStudentPassword(roll);
  forgetSessions();
  await audit(req, 'user.password_reset', roll);
  res.json({ ok: true });
});

adm.post('/users/:roll/logout', async (req, res) => {
  const u = await one('SELECT * FROM users WHERE roll_no = ?', normRoll(req.params.roll));
  if (u) await revokeSessions('student', u.id);
  await audit(req, 'user.sessions_revoked', normRoll(req.params.roll));
  res.json({ ok: true });
});

adm.delete('/users/:roll', requireSuper, async (req, res) => {
  const roll = normRoll(req.params.roll);
  const u = await one('SELECT * FROM users WHERE roll_no = ?', roll);
  if (!u) return res.status(404).json({ error: 'NOT_FOUND', message: 'This student has not registered.' });
  await tx(async () => { await revokeSessions('student', u.id); await run('DELETE FROM users WHERE id = ?', u.id); });
  const { password_hash, ...logged } = u;
  await audit(req, 'user.registration_reset', roll, { user: logged });
  res.json({ ok: true });
});

// ---------- Sprint questions (one set per Sprint ID). Everyone can read; super admins edit.
adm.get('/sprints', async (req, res) => {
  const mine = await sprintFor({ kind: 'admin', id: req.admin.id });
  res.json({ sprints: await listSprints({ include: mine.previewOf }), previewSprint: mine.previewOf || null });
});
// Which Sprint this super admin's portal preview shows (null = the current Sprint). Students are not affected.
adm.post('/preview', requireSuper, async (req, res) => {
  const id = req.body && req.body.sprintId ? String(req.body.sprintId).trim() : '';
  if (id && !/^[A-Za-z0-9_.-]{3,60}$/.test(id)) return res.status(400).json({ error: 'BAD_SPRINT', message: 'Unknown Sprint ID.' });
  await setPreviewSprint({ kind: 'admin', id: req.admin.id }, id || null);
  res.json({ ok: true, previewSprint: (await sprintFor({ kind: 'admin', id: req.admin.id })).previewOf || null });
});
adm.get('/sprints/:sid/questions', async (req, res) => res.json(await listQuestions(req.params.sid)));
adm.post('/sprints/:sid/questions', requireSuper, async (req, res) => {
  const q = await addQuestion(req.params.sid, req.body, req.admin.email);
  await audit(req, 'question.added', req.params.sid, { id: q.id, q: q.q.slice(0, 200) });
  res.json({ ok: true, question: q });
});
adm.put('/sprints/:sid/questions/:qid', requireSuper, async (req, res) => {
  const q = await updateQuestion(req.params.sid, req.params.qid, req.body, req.admin.email);
  await audit(req, 'question.updated', req.params.sid, { id: q.id, q: q.q.slice(0, 200) });
  res.json({ ok: true, question: q });
});
adm.delete('/sprints/:sid/questions/:qid', requireSuper, async (req, res) => {
  const q = await deleteQuestion(req.params.sid, req.params.qid);
  await audit(req, 'question.deleted', req.params.sid, { question: q });
  res.json({ ok: true });
});
adm.post('/sprints/:sid/questions/reorder', requireSuper, async (req, res) => {
  await reorderQuestions(req.params.sid, req.body && req.body.ids);
  await audit(req, 'question.reordered', req.params.sid);
  res.json({ ok: true });
});
adm.post('/sprints/:sid/questions/copy', requireSuper, async (req, res) => {
  const n = await copyQuestions(req.params.sid, String((req.body && req.body.from) || ''), req.admin.email);
  await audit(req, 'question.copied', req.params.sid, { from: req.body && req.body.from, count: n });
  res.json({ ok: true, count: n });
});

// ---------- student analytics (super admin): time, clicks, units, logins per student
const daysOf = (req) => Math.min(365, Math.max(1, Number(req.query.days) || 30));
adm.get('/analytics/business', requireSuper, async (req, res) => res.json(await businessMetrics({ sprintId: req.query.sprint ? String(req.query.sprint) : '', fresh: req.query.fresh === '1' })));
adm.get('/analytics/overview', requireSuper, async (req, res) => res.json(await analyticsOverview({ days: daysOf(req) })));
adm.get('/analytics/students', requireSuper, async (req, res) => res.json(await studentRows({ q: String(req.query.q || '').trim(), days: daysOf(req),
  sort: String(req.query.sort || 'time'), limit: Number(req.query.limit) || 500, offset: Number(req.query.offset) || 0 })));
adm.get('/analytics/students/:roll', requireSuper, async (req, res) => {
  const d = await studentDetail(normRoll(req.params.roll), { days: daysOf(req) });
  if (!d) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such NIAT ID.' });
  res.json(d);
});

// ---------- practice analytics (attempts per practice question, correct %, option spread, coding solved)
adm.get('/practice', async (req, res) => {
  res.json(await practiceAnalytics({ fresh: req.query.fresh === '1' }));
});
adm.get('/practice/:gi', async (req, res) => {
  const d = await practiceQuestion(Number(req.params.gi));
  if (!d) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such practice question.' });
  res.json(d);
});

const ATTEMPT_LIST = `SELECT a.id, a.roll_no, m.name, m.batch, a.status, a.started_at, a.deadline_at, a.submitted_at, a.auto_submitted,
  a.mcq_score, a.code_score, a.text_score, a.text_reviewed, a.total, a.max_total, a.used_ms, a.violations, a.proctor
  FROM attempts a LEFT JOIN students_master m ON m.roll_no = a.roll_no`;

adm.get('/attempts', async (req, res) => {
  await maybeFinalize();
  const sprintId = String(req.query.sprint || (await getSprint()).id);
  const where = ['a.sprint_id = ?', "a.roll_no NOT LIKE 'ADMIN-%'"], p = [sprintId];
  if (req.query.status) { where.push('a.status = ?'); p.push(String(req.query.status)); }
  if (req.query.review === 'pending') where.push("a.status = 'submitted' AND a.text_reviewed = 0");
  if (req.query.flagged === '1') where.push('a.violations > 0');
  if (req.query.q) { where.push('(a.roll_no ILIKE ? OR m.name ILIKE ?)'); p.push('%' + req.query.q + '%', '%' + req.query.q + '%'); }
  const [sprints, rows] = await Promise.all([
    all("SELECT sprint_id, COUNT(*) AS n FROM attempts WHERE roll_no NOT LIKE 'ADMIN-%' GROUP BY sprint_id ORDER BY MAX(started_at) DESC"),
    all(`${ATTEMPT_LIST} WHERE ${where.join(' AND ')} ORDER BY a.total DESC NULLS LAST, a.used_ms ASC LIMIT 2000`, ...p)
  ]);
  res.json({ sprints, rows: rows.map((r) => ({ ...r, proctor: proctorView(r) })) });
});

adm.get('/attempts/:id', async (req, res) => {
  const a = await one('SELECT * FROM attempts WHERE id = ?', Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'NOT_FOUND', message: 'Attempt not found.' });
  const m = await one('SELECT name, batch, phone FROM students_master WHERE roll_no = ?', a.roll_no);
  const answers = a.status === 'running' ? await readDraft(a) : parseJSON(a.answers, {});
  res.json({
    attempt: { ...a, draft: undefined, proctor: undefined, answers, detail: parseJSON(a.detail, {}) },
    proctor: { ...proctorView(a), events: await attemptEvents(a.id), labels: VIOLATIONS },
    student: m, questions: await getQuestions(a.sprint_id), marks: MARKS, result: a.status === 'submitted' ? resultView(a) : null
  });
});

adm.patch('/attempts/:id/marks', async (req, res) => {
  const before = await one('SELECT total FROM attempts WHERE id = ?', Number(req.params.id));
  const a = await setTextMarks(Number(req.params.id), req.body.marks);
  await audit(req, 'attempt.marks_set', a.roll_no, { attemptId: a.id, marks: req.body.marks, totalBefore: before && before.total, totalAfter: a.total });
  res.json({ ok: true, total: a.total });
});

adm.delete('/attempts/:id', requireSuper, async (req, res) => {
  const a = await one('SELECT * FROM attempts WHERE id = ?', Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'NOT_FOUND', message: 'Attempt not found.' });
  await run('DELETE FROM attempt_events WHERE attempt_id = ?', a.id);
  await run('DELETE FROM attempts WHERE id = ?', a.id);
  await clearBoardCache();
  await audit(req, 'attempt.reset', a.roll_no, { snapshot: { ...a, draft: parseJSON(a.draft), answers: parseJSON(a.answers), detail: parseJSON(a.detail) } });
  res.json({ ok: true });
});

adm.get('/leaderboard', async (req, res) => {
  await maybeFinalize();
  const sprint = await getSprint();
  res.json({ rule: RANK_RULE, sprint, rows: await leaderboardRows(String(req.query.sprint || sprint.id), 20000) });
});

// ---------- master data
adm.get('/imports', async (req, res) => {
  res.json({ studentsFile: config.isVercel ? null : studentsFilePath(), exists: !config.isVercel && fs.existsSync(studentsFilePath()), vercel: config.isVercel,
    rows: (await all('SELECT * FROM imports ORDER BY id DESC LIMIT 50')).map((r) => ({ ...r, errors: parseJSON(r.errors, {}) })) });
});
adm.post('/import/preview', async (req, res) => {
  const r = readStudents(await rowsFrom(req.body));
  const existing = new Set((await all('SELECT roll_no FROM students_master')).map((x) => x.roll_no));
  res.json({ error: r.error, rowsTotal: r.rowsTotal || 0, valid: r.students.length, errors: r.errors.slice(0, 200), warnings: r.warnings.slice(0, 200),
    newCount: r.students.filter((s) => !existing.has(s.roll_no)).length, sample: r.students.slice(0, 8) });
});
// "replace": this upload becomes the master list (students not in it are deactivated). "merge": add/update only.
adm.post('/import', requireSuper, async (req, res) => {
  const mode = req.body.mode === 'merge' ? 'merge' : 'replace';
  const r = await importStudents(req.body, { source: mode === 'replace' ? 'file' : 'admin', fileName: String(req.body.fileName || 'upload.csv'), adminId: req.admin.id, fullSync: mode === 'replace' });
  if (r.error) return res.status(400).json({ error: 'BAD_FILE', message: r.error, errors: (r.errors || []).slice(0, 200) });
  logImport(req.body.fileName || 'upload', r);
  forgetSessions();
  await clearBoardCache();
  await audit(req, 'students.imported', req.body.fileName || null, { mode, inserted: r.inserted, updated: r.updated, deactivated: r.deactivated, rejected: r.errors.length });
  res.json({ ...r, errors: r.errors.slice(0, 200), warnings: r.warnings.slice(0, 200) });
});
adm.post('/import/reload', requireSuper, async (req, res) => {
  if (config.isVercel) return res.status(400).json({ error: 'NO_FILE', message: 'On Vercel, upload the CSV here instead.' });
  const r = await syncStudentsFile({ force: true, adminId: req.admin.id });
  if (r.error) return res.status(400).json({ error: 'BAD_FILE', message: r.error, errors: (r.errors || []).slice(0, 200) });
  forgetSessions();
  await audit(req, 'students.reloaded', path.basename(studentsFilePath()), { inserted: r.inserted, updated: r.updated, deactivated: r.deactivated });
  res.json({ ...r, errors: r.errors.slice(0, 200), warnings: r.warnings.slice(0, 200) });
});

// ---------- unit content: Watch (MP4) · Play (HTML) · Read (HTML) per unit
const slotOk = (req, res) => {
  const { unitId, slot } = req.params;
  if (!lessonIds().has(unitId)) { res.status(404).json({ error: 'NOT_FOUND', message: 'Unknown unit.' }); return false; }
  if (!SLOTS.includes(slot)) { res.status(404).json({ error: 'NOT_FOUND', message: 'Step must be watch, play or read.' }); return false; }
  return true;
};
const typeError = (slot) => (slot === 'watch' ? 'Upload an MP4 (or WebM) video.' : 'Upload a single .html file.');
adm.get('/media', async (req, res) => {
  const kind = storageKind();
  res.json({ lessons: await catalog(), storage: kind, blob: kind === 'blob', s3: kind === 's3', localUpload: kind === 'local',
    maxBytes: config.maxVideoBytes, maxHtmlBytes: maxBytesFor('play'),
    folder: config.isVercel ? 'server/public/learning-bytes/ (in the repository; redeploy after adding files)' : config.learningBytesDir });
});
// S3-compatible storage (Cloudflare R2…): hand the browser a signed URL to PUT the file to directly.
adm.post('/media/:unitId/:slot/presign', async (req, res) => {
  if (!slotOk(req, res)) return;
  if (!s3Enabled()) return res.status(400).json({ error: 'NO_S3', message: 'S3/R2 storage is not configured.' });
  const { unitId, slot } = req.params, type = String(req.body.contentType || '');
  if (!typesFor(slot).includes(type)) return res.status(415).json({ error: 'BAD_TYPE', message: typeError(slot) });
  if (Number(req.body.size) > maxBytesFor(slot)) return res.status(413).json({ error: 'TOO_LARGE', message: 'File too large.' });
  res.json(await presignUpload(unitId, slot, type));
});
// Register a file uploaded to Blob or S3/R2.
adm.post('/media/:unitId/:slot', async (req, res) => {
  if (!slotOk(req, res)) return;
  const { unitId, slot } = req.params, url = String(req.body.url || '');
  const storage = isS3Url(url) ? 's3' : isBlobUrl(url) ? 'blob' : null;
  if (!storage) return res.status(400).json({ error: 'BAD_URL', message: 'That URL is not in this site’s storage.' });
  await setContent(unitId, slot, { url, storage, fileName: req.body.fileName, size: Number(req.body.size) || null, contentType: req.body.contentType, by: req.admin.email });
  await audit(req, 'media.uploaded', unitId + ':' + slot, { url, fileName: req.body.fileName, size: req.body.size });
  res.json({ ok: true });
});
// Play/Read: one self-contained HTML file, sent as JSON text and stored in the database (works on every platform).
adm.post('/media/:unitId/:slot/html', async (req, res) => {
  if (!slotOk(req, res)) return;
  const { unitId, slot } = req.params;
  if (slot === 'watch') return res.status(415).json({ error: 'BAD_TYPE', message: 'Watch needs an MP4 video.' });
  const html = typeof req.body.html === 'string' ? req.body.html : '';
  if (!html.trim()) return res.status(400).json({ error: 'EMPTY', message: 'The file is empty.' });
  if (Buffer.byteLength(html) > maxBytesFor(slot)) return res.status(413).json({ error: 'TOO_LARGE', message: 'HTML file too large (max 3 MB).' });
  if (!/<(!doctype|html|body|head|div|script|p|h1)/i.test(html)) return res.status(400).json({ error: 'NOT_HTML', message: 'That does not look like an HTML page.' });
  await setHtmlContent(unitId, slot, { html, fileName: String(req.body.fileName || slot + '.html').slice(0, 200), by: req.admin.email });
  await audit(req, 'media.uploaded', unitId + ':' + slot, { storage: 'db', fileName: req.body.fileName, size: Buffer.byteLength(html) });
  res.json({ ok: true });
});
// Self-hosted / local: stream the file to data/uploads.
adm.put('/media/:unitId/:slot/local', async (req, res) => {
  if (!slotOk(req, res)) return;
  if (config.isVercel) return res.status(400).json({ error: 'USE_BLOB', message: 'Use Blob upload on Vercel.' });
  const { unitId, slot } = req.params, max = maxBytesFor(slot);
  const type = String(req.headers['content-type'] || '').split(';')[0];
  if (!typesFor(slot).includes(type)) return res.status(415).json({ error: 'BAD_TYPE', message: typeError(slot) });
  if (Number(req.headers['content-length'] || 0) > max) return res.status(413).json({ error: 'TOO_LARGE', message: 'File too large.' });
  fs.mkdirSync(config.localUploadsDir, { recursive: true });
  const name = `${unitId}-${slot}-${Date.now()}.${extFor(slot, type)}`, file = path.join(config.localUploadsDir, name);
  let size = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    req.on('data', (c) => { size += c.length; if (size > max) { req.destroy(); out.destroy(); reject(new SprintError('TOO_LARGE', 'File too large.', 413)); } });
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    req.on('error', reject);
  }).catch((e) => { try { fs.unlinkSync(file); } catch {} throw e; });
  await setContent(unitId, slot, { url: '/uploads/' + name, storage: 'local', fileName: decodeURIComponent(String(req.headers['x-file-name'] || name)).slice(0, 200), size, contentType: type, by: req.admin.email });
  await audit(req, 'media.uploaded', unitId + ':' + slot, { storage: 'local', size });
  res.json({ ok: true });
});
adm.delete('/media/:unitId/:slot', async (req, res) => {
  if (!slotOk(req, res)) return;
  const r = await removeContent(req.params.unitId, req.params.slot);
  if (!r) return res.status(404).json({ error: 'NOT_FOUND', message: 'Nothing uploaded for this step.' });
  await audit(req, 'media.removed', req.params.unitId + ':' + req.params.slot, { url: r.url });
  res.json({ ok: true });
});

// ---------- feedback, audit
adm.get('/feedback', async (req, res) => {
  res.json({ rows: await all('SELECT f.*, m.name FROM feedback f LEFT JOIN students_master m ON m.roll_no = f.roll_no ORDER BY f.id DESC LIMIT 1000') });
});
adm.get('/audit', async (req, res) => {
  res.json({ rows: (await all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 500')).map((r) => ({ ...r, detail: parseJSON(r.detail) })) });
});

// ---------- exports (CSV)
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const HEAD = { roll_no: 'niat_id' }; // exports show the NIAT ID column under its real name
const toCSV = (cols, rows) => [cols.map((c) => HEAD[c] || c).join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
const mmss = (ms) => (ms == null ? '' : Math.floor(ms / 60000) + ':' + String(Math.floor(ms / 1000) % 60).padStart(2, '0'));

adm.get('/export/:what', async (req, res) => {
  const sprint = await getSprint();
  let name, body;
  if (req.params.what === 'results.csv') {
    const rankOf = new Map((await leaderboardRows(sprint.id)).map((r) => [r.roll_no, r.rank]));
    const rows = (await all(`${ATTEMPT_LIST} WHERE a.sprint_id = ? AND a.roll_no NOT LIKE 'ADMIN-%' ORDER BY a.total DESC NULLS LAST, a.used_ms ASC`, sprint.id))
      .map((r) => ({ ...r, rank: rankOf.get(r.roll_no) || '', time_used: mmss(r.used_ms), started: iso(r.started_at), submitted: iso(r.submitted_at), auto: r.auto_submitted ? 'yes' : '', reviewed: r.text_reviewed ? 'yes' : 'no', ended_by_violations: proctorView(r).endedBy === 'violations' ? 'yes' : '' }));
    name = `results-${sprint.id}.csv`;
    body = toCSV(['rank', 'roll_no', 'name', 'batch', 'status', 'total', 'max_total', 'mcq_score', 'code_score', 'text_score', 'reviewed', 'time_used', 'started', 'submitted', 'auto', 'violations', 'ended_by_violations'], rows);
  } else if (req.params.what === 'students.csv') {
    const rows = (await all(`SELECT m.*, u.status AS account, u.created_at AS reg_at, u.last_login_at, pr.data FROM students_master m
      LEFT JOIN users u ON u.roll_no = m.roll_no LEFT JOIN progress pr ON pr.roll_no = m.roll_no ORDER BY m.roll_no`))
      .map((r) => ({ ...r, ...progressSummary(r.data), active: r.active ? 'yes' : 'no', account: r.account || 'not registered', registered: iso(r.reg_at), last_login: iso(r.last_login_at) }));
    name = 'students.csv';
    body = toCSV(['roll_no', 'lms_id', 'name', 'phone', 'batch', 'email', 'active', 'account', 'registered', 'last_login', 'lessons', 'practice', 'solved'], rows);
  } else if (req.params.what === 'feedback.csv') {
    const rows = (await all('SELECT f.*, m.name FROM feedback f LEFT JOIN students_master m ON m.roll_no = f.roll_no ORDER BY f.id')).map((r) => ({ ...r, at: iso(r.created_at) }));
    name = 'feedback.csv';
    body = toCSV(['at', 'roll_no', 'name', 'kind', 'rating', 'text'], rows);
  } else if (req.params.what === 'activity.csv') {
    if (req.admin.role !== 'super_admin') return res.status(403).json({ error: 'FORBIDDEN', message: 'Super admins only.' });
    const d = await studentRows({ days: daysOf(req), limit: 100000 });
    const mins = (ms) => Math.round(ms / 6000) / 10;
    const rows = d.rows.map((r) => ({ ...r, portal_minutes: mins(r.portal_ms), unit_minutes: mins(r.ms), learn_minutes: mins(r.learn_ms), practice_minutes: mins(r.practice_ms), video_minutes: mins(r.video_ms), sprint_minutes: mins(r.sprint_ms),
      last_active: iso(r.last_active), last_login: iso(r.last_login_at), registered: r.registered ? 'yes' : 'no' }));
    name = `activity-last-${d.days}-days.csv`;
    body = toCSV(['roll_no', 'name', 'batch', 'registered', 'logins', 'last_login', 'last_active', 'days_active', 'portal_minutes', 'unit_minutes', 'learn_minutes', 'video_minutes', 'practice_minutes', 'sprint_minutes',
      'units_opened', 'unit_clicks', 'steps_done', 'units_completed', 'practice_answered', 'practice_correct', 'coding_solved'], rows);
  } else return res.status(404).json({ error: 'NOT_FOUND', message: 'Unknown export.' });
  await audit(req, 'export', req.params.what);
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
  res.send('﻿' + body);
});

// ---------- settings (super admin)
adm.get('/settings', async (req, res) => res.json({ sprint: await getSprint(), marks: MARKS, questions: (await getQuestions()).length, proctor: await proctorSettings(), reviewMode: await reviewMode((await getSprint()).id),
  registrationAutoApprove: !!(await getSetting('registration_auto_approve', false)), loginMode: await loginMode(), passMark: Number(await getSetting('pass_mark_pct', 40)) }));
adm.patch('/settings', requireSuper, async (req, res) => {
  const b = req.body || {}, before = await getSprint(), changes = {};
  if (b.sprint_id !== undefined) {
    const id = String(b.sprint_id).trim();
    if (!/^[A-Za-z0-9_.-]{3,60}$/.test(id)) throw new AuthError('BAD_SETTING', 'Sprint ID: 3–60 letters, digits, dot, dash or underscore.', 400);
    changes.sprint_id = id;
  }
  if (b.sprint_title !== undefined) changes.sprint_title = String(b.sprint_title).trim().slice(0, 80) || 'Saturday Sprint';
  for (const k of ['sprint_open', 'sprint_close']) {
    if (b[k] === undefined) continue;
    if (!Number.isFinite(Date.parse(b[k]))) throw new AuthError('BAD_SETTING', 'Invalid date/time for ' + k + '.', 400);
    changes[k] = new Date(Date.parse(b[k])).toISOString();
  }
  if (b.sprint_duration_min !== undefined) {
    const n = Number(b.sprint_duration_min);
    if (!Number.isInteger(n) || n < 1 || n > 600) throw new AuthError('BAD_SETTING', 'Duration must be 1–600 minutes.', 400);
    changes.sprint_duration_min = n;
  }
  if (b.leaderboard_visible !== undefined) changes.leaderboard_visible = !!b.leaderboard_visible;
  if (b.registration_auto_approve !== undefined) changes.registration_auto_approve = !!b.registration_auto_approve;
  if (b.pass_mark_pct !== undefined) {
    const n = Number(b.pass_mark_pct);
    if (!Number.isFinite(n) || n < 1 || n > 100) throw new AuthError('BAD_SETTING', 'Pass mark: 1 to 100 (% of total marks).', 400);
    changes.pass_mark_pct = Math.round(n * 10) / 10;
  }
  if (b.student_login_mode !== undefined) changes.student_login_mode = b.student_login_mode === 'secure' ? 'secure' : 'simple';
  for (const k of ['proctor_enabled', 'proctor_fullscreen', 'proctor_block_copy']) if (b[k] !== undefined) changes[k] = !!b[k];
  if (b.proctor_max_violations !== undefined) {
    const n = Number(b.proctor_max_violations);
    if (!Number.isInteger(n) || n < 0 || n > 50) throw new AuthError('BAD_SETTING', 'Violation limit: 0 (never auto-submit) to 50.', 400);
    changes.proctor_max_violations = n;
  }
  const open = Date.parse(changes.sprint_open || before.open), close = Date.parse(changes.sprint_close || before.close);
  if (!(close > open)) throw new AuthError('BAD_SETTING', 'Close time must be after open time.', 400);
  if (b.review_mode !== undefined) await setReviewMode(changes.sprint_id || before.id, String(b.review_mode));
  for (const [k, v] of Object.entries(changes)) await setSetting(k, v);
  clearSettingCache();
  await clearBoardCache();
  await audit(req, 'settings.updated', null, { before, changes });
  res.json({ ok: true, sprint: await getSprint() });
});

// ---------- admin accounts (super admin)
adm.get('/admins', requireSuper, async (req, res) => {
  res.json({ rows: await all('SELECT id, email, name, role, status, totp_enabled, must_change_pw, created_at, last_login_at, locked_until FROM admins ORDER BY id') });
});
adm.post('/admins', requireSuper, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError('BAD_EMAIL', 'Enter a valid email.', 400);
  if (await one('SELECT 1 AS x FROM admins WHERE email = ?', email)) throw new AuthError('EXISTS', 'An admin with that email exists.', 409);
  const role = req.body.role === 'super_admin' ? 'super_admin' : 'admin';
  const temp = generatePassword();
  await run('INSERT INTO admins (email, name, role, password_hash, must_change_pw, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    email, String(req.body.name || '').trim().slice(0, 80), role, hashPassword(temp), Date.now());
  await audit(req, 'admin.created', email, { role });
  res.json({ ok: true, tempPassword: temp });
});
adm.patch('/admins/:id', requireSuper, async (req, res) => {
  const id = Number(req.params.id), a = await one('SELECT * FROM admins WHERE id = ?', id);
  if (!a) return res.status(404).json({ error: 'NOT_FOUND', message: 'Admin not found.' });
  const out = { ok: true };
  if (id === req.admin.id && (req.body.status === 'disabled' || req.body.role === 'admin'))
    throw new AuthError('SELF', 'You cannot disable or demote yourself.', 400);
  if (req.body.role) await run('UPDATE admins SET role = ? WHERE id = ?', req.body.role === 'super_admin' ? 'super_admin' : 'admin', id);
  if (req.body.status) {
    await run('UPDATE admins SET status = ? WHERE id = ?', req.body.status === 'disabled' ? 'disabled' : 'active', id);
    if (req.body.status === 'disabled') await revokeSessions('admin', id);
  }
  if (req.body.resetPassword) {
    out.tempPassword = generatePassword();
    await run('UPDATE admins SET password_hash = ?, must_change_pw = 1, failed_logins = 0, locked_until = 0 WHERE id = ?', hashPassword(out.tempPassword), id);
    await revokeSessions('admin', id);
  }
  if (req.body.resetTotp) { await run('UPDATE admins SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0 WHERE id = ?', id); await revokeSessions('admin', id); }
  if (req.body.unlock) await run('UPDATE admins SET failed_logins = 0, locked_until = 0 WHERE id = ?', id);
  await audit(req, 'admin.updated', a.email, { role: req.body.role, status: req.body.status, resetPassword: !!req.body.resetPassword, resetTotp: !!req.body.resetTotp, unlock: !!req.body.unlock });
  res.json(out);
});

// ===================================================================== errors
api.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'No such API route.' }));
app.use((err, req, res, next) => {
  if (err instanceof AuthError || err instanceof SprintError) {
    return res.status(err.status).json({ error: err.code, message: err.message, ...(err.extra || {}) });
  }
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'BAD_JSON', message: 'Invalid JSON.' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'TOO_LARGE', message: 'Upload too large.' });
  console.error('[error]', req.method, req.originalUrl, err);
  res.status(500).json({ error: 'SERVER', message: 'Something went wrong. Please try again.' });
});

// ===================================================================== local server
// WEB_CONCURRENCY > 1: one process per CPU core behind one port (Node cluster). Requires Postgres + Redis,
// because PGlite and in-memory caches cannot be shared between processes.
export async function start() {
  if (config.webConcurrency > 1 && cluster.isPrimary) {
    if (!config.databaseUrl || !kv.kvShared) {
      console.warn('[cluster] WEB_CONCURRENCY needs DATABASE_URL and REDIS_URL; running a single process.');
    } else {
      console.log(`[cluster] starting ${config.webConcurrency} worker processes`);
      const slot = new Map();
      const fork = (i) => slot.set(cluster.fork({ WORKER_INDEX: String(i) }).id, i);
      for (let i = 0; i < config.webConcurrency; i++) fork(i);
      cluster.on('exit', (w, code) => { console.error(`[cluster] worker ${w.process.pid} exited (${code}); restarting`); fork(slot.get(w.id) ?? 1); slot.delete(w.id); });
      return null;
    }
  }
  const lead = !cluster.isWorker || process.env.WORKER_INDEX === '0';
  await ready();
  startGrader();
  if (lead) watchStudentsFile();
  const t = setInterval(() => { if (lead) finalizeExpired().catch((e) => console.error('[sprint]', e.message)); }, 20000);
  t.unref();
  const c = setInterval(() => { if (lead) cleanupExpired().catch(() => {}); }, 3600000);
  c.unref();
  const server = app.listen(config.port, config.host);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`\n  Port ${config.port} is already in use: another copy of the server is probably running.\n  Stop it (Ctrl+C in its window) and run npm start again, or use another port: set PORT=3001 in server/.env.\n`);
    else console.error('[server]', e.message);
    process.exit(1);
  });
  server.on('listening', async () => {
    const admins = (await one('SELECT COUNT(*) AS n FROM admins')).n;
    console.log(`\n  Saturday Sprint running at http://localhost:${server.address().port}`);
    console.log(`  Students: /login   Admin: /admin   OTP: ${config.otp.provider}${config.otp.devShow ? ' (codes shown on screen)' : ''}`);
    if (!lead) return;
    console.log(`  Database: ${dbKind()}   Redis: ${kv.kvKind}   Video uploads: ${storageKind()}   Processes: ${cluster.isWorker ? config.webConcurrency : 1}`);
    if (!admins) console.log('  No admin yet. Create one:  npm run create-admin -- --email you@example.com --name "Your Name" --super');
    try { builtinQuestions(); } catch (e) { console.warn('  ' + e.message); }
    console.log('');
  });
  const stop = () => { stopGrader(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return server;
}

export { app, clearContentCache };
export default app;
if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'index.js')) start();
