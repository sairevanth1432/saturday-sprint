// End-to-end: runs the real server against a throwaway data folder.
//   npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-test-'));
process.env.DATA_DIR = DATA;
process.env.STUDENTS_FILE = path.join(DATA, 'students.csv');
process.env.OTP_PROVIDER = 'console';
process.env.ADMIN_REQUIRE_TOTP = 'true'; // tests must not depend on a developer's local .env
process.env.OTP_DEV_SHOW = 'true';
process.env.OTP_RESEND_SECONDS = '0';
process.env.PORT = '0';
process.env.SPRINT_OPEN = new Date(Date.now() + 86400000).toISOString();
process.env.SPRINT_CLOSE = new Date(Date.now() + 2 * 86400000).toISOString();

const here = path.dirname(fileURLToPath(import.meta.url));

let server, base, mod, db, sec;
const log = console.log;
// A tiny photo data URL: registration requires a photograph.
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP==';
before(async () => {
  console.log = () => {};
  mod = await import('../index.js');
  db = await import('../db.js');
  sec = await import('../security.js');
  // The real next-Sprint switch (content/sprint.json) would change the Sprint mid-suite; one test turns it on.
  (await import('../sprint.js')).setScheduleForTest(null);
  server = await mod.start();
  await new Promise((r) => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  console.log = log;
  const { stopGrader } = await import('../grader.js');
  await stopGrader();
  server.close();
  await db.close();
  fs.unwatchFile(path.join(DATA, 'students.csv'));
});

function client() {
  const jar = {};
  const call = async function (method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; '), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, text, headers: res.headers };
  };
  call.cookie = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
  return call;
}

const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 200)); }
  return false;
};

// Full student journey: register with own phone → pending → admin approves → log in.
async function signup(c, roll, phone) {
  const s = await c('POST', '/api/auth/register/start', { rollNo: roll, phone });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const v = await c('POST', '/api/auth/register/verify', { rollNo: roll, otp: s.body.devOtp, phone, photo: PHOTO, password: 'Sprint2026' });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.status, 'pending');
  const { approveRequest } = await import('../auth.js');
  const req = await db.one("SELECT id FROM registration_requests WHERE roll_no = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", roll.toUpperCase());
  await approveRequest(req.id, 'test');
  await login(c, roll);
}
async function login(c, roll) {
  const s = await c('POST', '/api/auth/login/start', { rollNo: roll });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const v = await c('POST', '/api/auth/login/verify', { rollNo: roll, otp: s.body.devOtp });
  assert.equal(v.status, 200, JSON.stringify(v.body));
}

const Q = JSON.parse(fs.readFileSync(path.join(here, '..', 'generated', 'sprint-test.json'), 'utf8'));
const ROLL = 'NIAT24001';

test('pages require login', async () => {
  const c = client();
  const r = await c('GET', '/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/login');
  assert.equal((await c('GET', '/login')).status, 200);
  assert.equal((await c('GET', '/api/bootstrap')).status, 401);
});

test('unknown roll number cannot register before master data exists', async () => {
  const r = await client()('POST', '/api/auth/register/start', { rollNo: ROLL });
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'ROLL_NOT_FOUND');
});

test('dropping students.csv in the data folder enables registration automatically', async () => {
  fs.writeFileSync(path.join(DATA, 'students.csv'),
    'Roll Number,Student Name,Mobile Number,Section\nniat24001,Asha Kumar,9876543210,A\nNIAT24002,Rahul Verma,+91 98765 43211,A\nNIAT24003,Priya,12345,B\nNIAT24002,Dup,9876500000,B\n');
  const ok = await waitFor(async () => (await db.one('SELECT COUNT(*) AS n FROM students_master')).n === 3);
  assert.ok(ok, 'file was not imported');
  const imp = await db.one('SELECT * FROM imports ORDER BY id DESC LIMIT 1');
  assert.equal(imp.inserted, 3);
  const log = JSON.parse(imp.errors);
  assert.equal(log.errors.length, 1); // duplicate NIAT ID
  assert.ok(log.warnings.some((w) => /not a valid mobile/.test(w.warning)), 'a bad sheet phone is only a warning now');
  assert.equal((await db.one('SELECT phone FROM students_master WHERE roll_no = ?', 'NIAT24003')).phone, '');
  assert.equal((await db.one('SELECT phone FROM students_master WHERE roll_no = ?', 'NIAT24002')).phone, '+919876543211');
});

test('register with OWN phone → pending until admin approves; impostor request is closed; login goes to own phone', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login/start', { rollNo: ROLL })).body.error, 'NOT_REGISTERED');
  assert.equal((await c('POST', '/api/auth/register/start', { rollNo: ROLL })).body.error, 'BAD_PHONE');
  const s = await c('POST', '/api/auth/register/start', { rollNo: ' niat24001 ', phone: '90000 00001' });
  assert.equal(s.status, 200);
  assert.equal(s.body.maskedPhone, '+91 90•••••001', 'the code goes to the number the student typed, not the sheet');
  const wrong = String((Number(s.body.devOtp) + 1) % 1000000).padStart(6, '0');
  assert.equal((await c('POST', '/api/auth/register/verify', { rollNo: ROLL, otp: wrong, phone: '9000000001', photo: PHOTO, password: 'Sprint2026' })).body.error, 'OTP_WRONG');
  // a code for one phone cannot be used with another phone
  assert.equal((await c('POST', '/api/auth/register/verify', { rollNo: ROLL, otp: s.body.devOtp, phone: '9000000099', photo: PHOTO, password: 'Sprint2026' })).body.error, 'OTP_EXPIRED');
  const v = await c('POST', '/api/auth/register/verify', { rollNo: ROLL, otp: s.body.devOtp, phone: '9000000001', photo: PHOTO, password: 'Sprint2026' });
  assert.equal(v.status, 200);
  assert.equal(v.body.status, 'pending');
  assert.equal((await c('GET', '/api/me')).status, 401, 'no session before approval');
  assert.equal((await c('POST', '/api/auth/login/start', { rollNo: ROLL })).body.error, 'PENDING_APPROVAL');

  // someone else tries to claim the same NIAT ID with their phone
  const x = client();
  const xs = await x('POST', '/api/auth/register/start', { rollNo: ROLL, phone: '9000000666' });
  await x('POST', '/api/auth/register/verify', { rollNo: ROLL, otp: xs.body.devOtp, phone: '9000000666', photo: PHOTO, password: 'Sprint2026' });
  const reqs = await db.all("SELECT id, phone FROM registration_requests WHERE roll_no = ? AND status = 'pending' ORDER BY id", ROLL);
  assert.equal(reqs.length, 2);

  const { approveRequest } = await import('../auth.js');
  await approveRequest(reqs.find((r) => r.phone === '+919000000001').id, 'test');
  assert.equal((await db.one("SELECT status FROM registration_requests WHERE phone = '+919000000666'")).status, 'superseded');
  const l = await c('POST', '/api/auth/login/start', { rollNo: ROLL });
  assert.equal(l.body.maskedPhone, '+91 90•••••001');
  assert.equal((await c('POST', '/api/auth/login/verify', { rollNo: ROLL, otp: l.body.devOtp })).status, 200);
  const me = await c('GET', '/api/me');
  assert.equal(me.body.rollNo, ROLL);
  assert.equal(me.body.name, 'Asha Kumar');
  assert.equal((await client()('POST', '/api/auth/register/start', { rollNo: ROLL, phone: '9000000002' })).body.error, 'ALREADY_REGISTERED');
  // one phone cannot hold two accounts
  assert.equal((await client()('POST', '/api/auth/register/start', { rollNo: 'NIAT24002', phone: '9000000001' })).body.error, 'PHONE_IN_USE');
  assert.equal((await db.one('SELECT COUNT(*) AS n FROM users WHERE roll_no = ?', ROLL)).n, 1);
  assert.equal((await c('GET', '/')).status, 200);
});

test('OTP locks after 5 wrong attempts', async () => {
  const c = client();
  const s = await c('POST', '/api/auth/login/start', { rollNo: ROLL });
  for (let i = 0; i < 5; i++) await c('POST', '/api/auth/login/verify', { rollNo: ROLL, otp: '000000' === s.body.devOtp ? '111111' : '000000' });
  const r = await c('POST', '/api/auth/login/verify', { rollNo: ROLL, otp: s.body.devOtp });
  assert.equal(r.body.error, 'OTP_LOCKED');
});

test('cross-site POST is blocked', async () => {
  const r = await client()('POST', '/api/auth/login/start', { rollNo: ROLL }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

let A, B;
test('Sprint: locked before the window, answers never sent to the browser, graded on the server', async () => {
  A = client(); B = client();
  await login(A, 'niat24001');
  assert.equal((await A('GET', '/api/me')).status, 200);
  await signup(B, 'NIAT24002', '9000000002');

  const boot = await A('GET', '/api/bootstrap');
  assert.equal(boot.body.sprint.types.length, Q.length);
  assert.equal(boot.body.attempt.status, 'none');
  assert.equal((await A('POST', '/api/sprint/start')).body.error, 'NOT_OPEN');

  await db.setSetting('sprint_open', new Date(Date.now() - 60000).toISOString());
  const st = await A('POST', '/api/sprint/start');
  assert.equal(st.status, 200, JSON.stringify(st.body));
  const qs = st.body.attempt.questions;
  assert.equal(qs.length, Q.length);
  assert.ok(qs.every((q) => q.c === undefined && q.tests === undefined), 'answers leaked');
  const html = (await A('GET', '/')).text;
  assert.ok(html.includes('test = []; // served by /api/sprint'), 'the test questions/answers are not in the page');

  const ci = Q.findIndex((q) => q.type === 'code');
  const good = 'n = int(input())\nprint(sum(i for i in range(2, n + 1, 2)))';
  if (ci >= 0) {
    const chk = await A('POST', '/api/sprint/check', { index: ci, code: good });
    assert.deepEqual(chk.body.results.map((x) => x.pass), Q[ci].tests.map(() => true));
  }
  assert.ok(Q.every((q) => q.type === 'mcq'), 'content/sprint.json keeps only MCQs');

  const all = { mcq: {}, text: {}, code: { [ci]: good } };
  Q.forEach((q, i) => { if (q.type === 'mcq') all.mcq[i] = q.c; if (q.type === 'text') all.text[i] = 'My answer ' + i; });
  assert.equal((await A('PUT', '/api/sprint/draft', all)).status, 200);
  const sub = await A('POST', '/api/sprint/submit', all);
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  const r = sub.body.attempt.result;
  const mcqN = Q.filter((q) => q.type === 'mcq').length;
  assert.equal(r.mcqRight, mcqN);
  assert.equal(r.score, mcqN + (ci >= 0 ? 1 : 0));
  assert.equal(r.maxTotal, Q.length);
  assert.equal(r.textPending, Q.some((q) => q.type === 'text'));
  assert.equal((await A('POST', '/api/sprint/start')).body.error, 'ALREADY_SUBMITTED');

  // B answers 3 MCQs, infinite-loops the coding question
  await B('POST', '/api/sprint/start');
  const bAns = { mcq: { 0: Q[0].c, 1: Q[1].c, 2: Q[2].c }, code: { [ci]: 'while True:\n    pass' } };
  const bs = await B('POST', '/api/sprint/submit', bAns);
  assert.equal(bs.body.attempt.result.score, 3);
});

test('leaderboard ranks by score then time, masks roll numbers', async () => {
  const lb = await B('GET', '/api/leaderboard');
  assert.equal(lb.status, 200);
  assert.equal(lb.body.participants, 2);
  assert.equal(lb.body.rows[0].name, 'Asha Kumar');
  assert.equal(lb.body.rows[0].rank, 1);
  assert.equal(lb.body.rows[0].id, 'NIAT•••01');
  assert.equal(lb.body.me.rank, 2);
  assert.equal(lb.body.me.me, true);
});

let ADM;
test('admin: password + mandatory authenticator, then full access', async () => {
  const pw = 'correct-horse-42-battery';
  await db.run('INSERT INTO admins (email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', 'boss@example.com', 'Boss', 'super_admin', sec.hashPassword(pw), Date.now());
  ADM = client();
  assert.equal((await ADM('GET', '/api/admin/overview')).status, 401);
  assert.equal((await ADM('POST', '/api/admin/login', { email: 'boss@example.com', password: 'nope' })).status, 401);
  const l = await ADM('POST', '/api/admin/login', { email: 'BOSS@example.com', password: pw });
  assert.equal(l.body.next, 'setup');
  assert.equal((await ADM('GET', '/api/admin/overview')).status, 401, 'setup-stage session must not reach data');
  const setup = await ADM('GET', '/api/admin/totp/setup');
  assert.match(setup.body.qrSvg, /^<svg/);
  const code = sec.totpAt(setup.body.secret, sec.totpStep());
  assert.equal((await ADM('POST', '/api/admin/totp/enable', { code })).status, 200);
  const ov = await ADM('GET', '/api/admin/overview');
  assert.equal(ov.status, 200);
  assert.equal(ov.body.counts.registered, 2);
  assert.equal(ov.body.attempts.submitted, 2);

  // a student cookie is not an admin cookie
  assert.equal((await A('GET', '/api/admin/overview')).status, 401);

  // second login needs the authenticator code
  const C = client();
  assert.equal((await C('POST', '/api/admin/login', { email: 'boss@example.com', password: pw })).body.next, 'totp');
  assert.equal((await C('POST', '/api/admin/login/totp', { code: '000000' })).status, 401);
});

test('admin: mark written answers → total and rank update; audit trail', async () => {
  const list = await ADM('GET', '/api/admin/attempts?status=submitted');
  const a = list.body.rows.find((r) => r.roll_no === ROLL);
  assert.equal(a.text_reviewed, 1, 'MCQ-only attempts need no marking');
  const textIdx = Q.map((q, i) => (q.type === 'text' ? i : -1)).filter((i) => i >= 0);
  const marks = Object.fromEntries(textIdx.map((i) => [i, 1]));
  const r = await ADM('PATCH', `/api/admin/attempts/${a.id}/marks`, { marks });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total, Q.length);
  if (textIdx.length) assert.equal((await ADM('PATCH', `/api/admin/attempts/${a.id}/marks`, { marks: { [textIdx[0]]: 5 } })).status, 400);
  const res = await A('GET', '/api/bootstrap');
  assert.equal(res.body.attempt.result.score, Q.length);
  assert.equal(res.body.attempt.result.textPending, false);
  const audit = await ADM('GET', '/api/admin/audit');
  assert.ok(audit.body.rows.some((x) => x.action === 'attempt.marks_set'));
  const csv = await ADM('GET', '/api/admin/export/results.csv');
  assert.match(csv.text, /NIAT24001/);
});

test('admin: disabling an account signs the student out and hides them from the board', async () => {
  assert.equal((await ADM('POST', '/api/admin/users/NIAT24002/status', { status: 'disabled' })).status, 200);
  assert.equal((await B('GET', '/api/bootstrap')).status, 401);
  const lb = await A('GET', '/api/leaderboard');
  assert.equal(lb.body.participants, 1);
  await ADM('POST', '/api/admin/users/NIAT24002/status', { status: 'active' });
});

test('updating the master file: removed students are deactivated; the account phone is the student\'s own', async () => {
  fs.writeFileSync(path.join(DATA, 'students.csv'), 'NIAT ID,Student Name,Phone No.\nNIAT24001,Asha Kumar,9876543210\nNIAT24003,Priya Nair,\n');
  assert.ok(await waitFor(async () => (await db.one('SELECT active FROM students_master WHERE roll_no = ?', 'NIAT24002')).active === 0));
  const s = await client()('POST', '/api/auth/login/start', { rollNo: ROLL });
  assert.equal(s.body.maskedPhone, '+91 90•••••001', 'login keeps using the approved own phone, not the sheet');
  assert.equal((await client()('POST', '/api/auth/login/start', { rollNo: 'NIAT24002' })).body.error, 'ROLL_NOT_FOUND');
  assert.equal((await B('GET', '/api/bootstrap')).status, 401);
  assert.equal((await client()('POST', '/api/auth/register/start', { rollNo: 'NIAT24003', phone: '9000000003' })).status, 200, 'no phone in the sheet is fine');
});

test('admin approvals screen: list, reject with reason, bulk approve, change login phone', async () => {
  const mk = async (roll, phone) => { const c = client(); const s = await c('POST', '/api/auth/register/start', { rollNo: roll, phone }); await c('POST', '/api/auth/register/verify', { rollNo: roll, otp: s.body.devOtp, phone, photo: PHOTO, password: 'Sprint2026' }); return c; };
  await db.run("INSERT INTO students_master (roll_no, name, phone, active, source, updated_at) VALUES ('N26P02A0901', 'Ravi', '+919000000901', 1, 'admin', 1), ('N26P02A0902', 'Sita', '', 1, 'admin', 1)");
  await mk('N26P02A0901', '9000000901');
  const sita = await mk('N26P02A0902', '9000000902');
  const list = await ADM('GET', '/api/admin/approvals');
  const ravi = list.body.rows.find((r) => r.roll_no === 'N26P02A0901'), s2 = list.body.rows.find((r) => r.roll_no === 'N26P02A0902');
  assert.equal(ravi.matches_sheet, true);
  assert.equal(s2.matches_sheet, false);
  assert.equal((await A('GET', '/api/admin/approvals')).status, 401, 'students cannot see approvals');
  const rj = await ADM('POST', '/api/admin/approvals/decide', { ids: [s2.id], action: 'reject', note: 'Use your own number' });
  assert.equal(rj.body.done, 1);
  const again = await sita('POST', '/api/auth/login/start', { rollNo: 'N26P02A0902' });
  assert.equal(again.body.error, 'REJECTED');
  assert.match(again.body.message, /Use your own number/);
  const ok = await ADM('POST', '/api/admin/approvals/decide', { ids: [ravi.id, s2.id], action: 'approve' });
  assert.equal(ok.body.done, 1);
  assert.equal(ok.body.failed.length, 1, 'an already-decided request is reported, not approved');
  assert.equal((await ADM('PATCH', '/api/admin/users/N26P02A0901/phone', { phone: '9000000002' })).body.error, 'PHONE_IN_USE');
  assert.equal((await ADM('PATCH', '/api/admin/users/N26P02A0901/phone', { phone: '9000000911' })).status, 200);
  const l = await client()('POST', '/api/auth/login/start', { rollNo: 'N26P02A0901' });
  assert.equal(l.body.maskedPhone, '+91 90•••••911');
  assert.ok((await ADM('GET', '/api/admin/audit')).body.rows.some((r) => r.action === 'registration.approved'));
});

test('expired unsubmitted attempts are auto-submitted from the last autosave', async () => {
  const C = client();
  await signup(C, 'NIAT24003', '9000000003');
  await C('POST', '/api/sprint/start');
  await C('PUT', '/api/sprint/draft', { mcq: { 0: Q[0].c } });
  await db.run("UPDATE attempts SET started_at = started_at - 7200000, deadline_at = ? WHERE roll_no = 'NIAT24003'", Date.now() - 600000);
  const { finalizeExpired } = await import('../sprint.js');
  assert.equal(await finalizeExpired(), 1);
  const b = await C('GET', '/api/bootstrap');
  assert.equal(b.body.attempt.status, 'submitted');
  assert.equal(b.body.attempt.result.score, 1);
  assert.equal(b.body.attempt.result.autoSubmitted, true);
});

test('unit content: admin uploads Watch (MP4), Play and Read (HTML) per unit; removing brings back the built-in file', async () => {
  const media = await ADM('GET', '/api/admin/media');
  assert.equal(media.status, 200);
  const unit = media.body.lessons.find((l) => l.id === 'tp-nested');
  assert.equal(unit.steps.watch.active, 'pack');
  assert.equal(unit.steps.play.active, 'pack');
  assert.equal(unit.steps.read.active, 'none', 'no reading material yet');
  const put = (slot, type, body, ck = ADM.cookie(), id = unit.id) =>
    fetch(base + '/api/admin/media/' + id + '/' + slot + '/local', { method: 'PUT', headers: { 'content-type': type, cookie: ck, 'x-file-name': 'notes.html' }, body });
  const fake = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(4000, 7)]);
  assert.equal((await put('watch', 'video/mp4', fake)).status, 200);
  const html = '<!doctype html><html><body><h1>Nested notes</h1><script>document.title="x"</script></body></html>';
  const up = await ADM('POST', '/api/admin/media/' + unit.id + '/read/html', { html, fileName: 'notes.html' });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal((await ADM('POST', '/api/admin/media/' + unit.id + '/watch/html', { html })).status, 415, 'Watch must be a video');
  assert.equal((await ADM('POST', '/api/admin/media/' + unit.id + '/play/html', { html: 'just text' })).status, 400, 'not HTML');
  // wrong types, unknown step / unit, and students are refused
  assert.equal((await put('read', 'video/mp4', fake)).status, 415);
  assert.equal((await put('watch', 'text/html', html)).status, 415);
  assert.ok([404, 415].includes((await put('quiz', 'text/html', html)).status), 'unknown step refused');
  assert.equal((await put('read', 'text/html', html, ADM.cookie(), 'nope')).status, 404);
  assert.equal((await put('read', 'text/html', html, A.cookie())).status, 401);

  const boot = await A('GET', '/api/bootstrap');
  const c = boot.body.unitContent[unit.id];
  assert.match(c.watch, /^\/uploads\/.+\.mp4$/);
  assert.match(c.read, /^\/api\/content\/tp-nested\/read\?v=\d+$/, 'HTML is served by the site, not file storage');
  const range = await fetch(base + c.watch, { headers: { range: 'bytes=0-99' } });
  assert.equal(range.status, 206, 'video supports seeking');
  const page = await fetch(base + c.read);
  const served = await page.text();
  assert.match(served, /Nested notes/);
  assert.match(served, /ssAct:1[\s\S]*<\/script><\/body>/, 'the page reports inputs to the portal (Student analytics time)');
  assert.match(page.headers.get('content-security-policy') || '', /sandbox allow-scripts/, 'uploaded HTML is sandboxed');

  assert.equal((await ADM('DELETE', '/api/admin/media/' + unit.id + '/read')).status, 200);
  assert.equal((await ADM('DELETE', '/api/admin/media/' + unit.id + '/watch')).status, 200);
  const after = (await ADM('GET', '/api/admin/media')).body.lessons.find((l) => l.id === unit.id);
  assert.equal(after.steps.watch.active, 'pack');
  assert.equal(after.steps.read.active, 'none');
  assert.equal((await A('GET', '/api/bootstrap')).body.unitContent[unit.id], undefined);
});

test('learning bytes: files named <lessonId>.mp4 in the folder are picked up; unknown names ignored', async () => {
  const { scanFolder } = await import('../media.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bytes-'));
  fs.writeFileSync(path.join(dir, 'tp-forloop.mp4'), 'x');
  fs.writeFileSync(path.join(dir, 'not-a-lesson.mp4'), 'x');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  const found = scanFolder(dir);
  assert.deepEqual(Object.keys(found), ['tp-forloop']);
  assert.match(found['tp-forloop'].url, /^\/learning-bytes\/tp-forloop\.mp4\?v=\d+$/);
});

test('Excel master data: NIAT ID sheet (numeric phones, LMS user id) imports and enables NIAT ID login', async () => {
  const writeXlsxFile = (await import('write-excel-file/node')).default;
  const H = ['User id', 'NIAT ID', 'Student Name', 'Email IDs', 'Phone No.'].map((v) => ({ value: v }));
  const row = (uid, id, name, mail, phone) => [{ value: uid }, { value: id }, { value: name }, { value: mail }, { value: phone, type: Number }];
  const file = path.join(DATA, 'niat.xlsx');
  await writeXlsxFile([H, row('1924c226-f1da-47f0-9552-b09abd2fedb8', 'N26P02A0001', 'Test Student One', 'one@example.com', 9876500001),
    row('b73fc5cb-70a4-4dc1-82da-4346c7565f64', 'n26p02a0002 ', 'Test Student Two', 'two@example.com', 9876500002),
    row('x', 'N26P02A0003', 'Bad Phone', 'bad@example.com', 12345)]).toFile(file);
  const xlsxBase64 = fs.readFileSync(file).toString('base64');
  const pv = await ADM('POST', '/api/admin/import/preview', { xlsxBase64 });
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.valid, 3, 'a bad phone no longer blocks the row (students bring their own phone)');
  assert.equal(pv.body.errors.length, 0);
  assert.equal(pv.body.warnings.length, 1);
  assert.equal(pv.body.sample[1].roll_no, 'N26P02A0002', 'NIAT IDs are trimmed and upper-cased');
  assert.equal(pv.body.sample[0].phone, '+919876500001', 'numeric Excel phone becomes +91…');
  const im = await ADM('POST', '/api/admin/import', { xlsxBase64, fileName: 'niat.xlsx', mode: 'merge' });
  assert.equal(im.status, 200, JSON.stringify(im.body));
  assert.equal(im.body.inserted, 3);
  assert.equal((await db.one('SELECT lms_id FROM students_master WHERE roll_no = ?', 'N26P02A0001')).lms_id, '1924c226-f1da-47f0-9552-b09abd2fedb8');
  const s = await client()('POST', '/api/auth/register/start', { rollNo: 'n26p02a0001', phone: '9876500001' });
  assert.equal(s.status, 200);
  assert.equal(s.body.maskedPhone, '+91 98•••••001');
  const bad = await client()('POST', '/api/auth/register/start', { rollNo: 'N26P02A9999' });
  assert.match(bad.body.message, /NIAT ID/);
});

test('units: 6 units, each ONE lesson with Watch → Play → Read; files are served by this server with seeking', async () => {
  const boot = await A('GET', '/api/bootstrap');
  assert.equal(boot.body.units.mode, 'replace');
  const units = boot.body.units.units;
  assert.equal(units.length, 6);
  assert.deepEqual([...new Set(units.map((u) => u.course))].sort(), ['genai', 'pf']);
  const nested = units.find((u) => u.name === 'Nested Conditional Statements');
  assert.equal(nested.lessons.length, 1, 'one lesson per unit');
  const tabs = nested.lessons[0].tabs;
  assert.deepEqual(Object.keys(tabs), ['watch', 'play', 'read']);
  assert.equal(tabs.read, null, 'Read comes later via the admin console');
  assert.equal(tabs.watch.orientation, 'portrait');
  const v = await fetch(base + tabs.watch.src, { headers: { range: 'bytes=0-1023' } });
  assert.equal(v.status, 206, 'video supports range requests');
  assert.match(v.headers.get('content-type'), /video\/mp4/);
  const g = await fetch(base + tabs.play.src);
  assert.equal(g.status, 200);
  assert.match(await g.text(), /<title>Nested Conditions<\/title>/);
  const media = await ADM('GET', '/api/admin/media');
  const row = media.body.lessons.find((l) => l.id === 'tp-nested');
  assert.equal(row.steps.watch.active, 'pack', 'admins see the built-in video and can replace it');
});

test('student password: register with a password → log in with NIAT ID + password; code login sets one; admin reset', async () => {
  const now = Date.now();
  for (const r of ['PWTEST01', 'PWTEST02']) {
    await db.run("INSERT INTO students_master (roll_no, name, phone, batch, email, active, source, updated_at) VALUES (?, ?, '', 'A', '', 1, 'admin', ?) ON CONFLICT (roll_no) DO NOTHING", r, 'Pw ' + r, now);
  }
  // 1) register with a password (weak passwords are refused at verify)
  const c = client();
  const s = await c('POST', '/api/auth/register/start', { rollNo: 'PWTEST01', phone: '9111100001' });
  assert.equal((await c('POST', '/api/auth/register/verify', { rollNo: 'PWTEST01', otp: s.body.devOtp, phone: '9111100001', photo: PHOTO, password: 'short' })).body.error, 'WEAK_PASSWORD');
  const s2 = await c('POST', '/api/auth/register/start', { rollNo: 'PWTEST01', phone: '9111100001' });
  const v = await c('POST', '/api/auth/register/verify', { rollNo: 'PWTEST01', otp: s2.body.devOtp, phone: '9111100001', photo: PHOTO, password: 'Sprint2026' });
  assert.equal(v.body.status, 'pending', JSON.stringify(v.body));
  assert.equal((await client()('POST', '/api/auth/password-login', { rollNo: 'PWTEST01', password: 'Sprint2026' })).body.error, 'PENDING_APPROVAL');
  const { approveRequest } = await import('../auth.js');
  await approveRequest((await db.one("SELECT id FROM registration_requests WHERE roll_no = 'PWTEST01' AND status = 'pending'")).id, 'test');
  const p = client();
  assert.equal((await p('POST', '/api/auth/password-login', { rollNo: 'pwtest01', password: 'Wrong2026' })).body.error, 'BAD_LOGIN');
  assert.equal((await p('POST', '/api/auth/password-login', { rollNo: 'NOSUCH99', password: 'Wrong2026' })).body.error, 'BAD_LOGIN', 'same answer for unknown IDs');
  const ok = await p('POST', '/api/auth/password-login', { rollNo: 'pwtest01', password: 'Sprint2026' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await p('GET', '/api/me')).body.hasPassword, true);
  // changing it from a normal session needs the current password
  assert.equal((await p('POST', '/api/auth/password', { password: 'Newpass2026' })).body.error, 'BAD_LOGIN');
  assert.equal((await p('POST', '/api/auth/password', { password: 'Newpass2026', current: 'Sprint2026' })).status, 200);
  assert.equal((await client()('POST', '/api/auth/password-login', { rollNo: 'PWTEST01', password: 'Newpass2026' })).status, 200);

  // 2) admin reset: the student is signed out, told to use a code, then sets a new password right after the code login
  const q = client();
  const s3 = await q('POST', '/api/auth/register/start', { rollNo: 'PWTEST02', phone: '9111100002' });
  await q('POST', '/api/auth/register/verify', { rollNo: 'PWTEST02', otp: s3.body.devOtp, phone: '9111100002', photo: PHOTO, password: 'Before2026' });
  await approveRequest((await db.one("SELECT id FROM registration_requests WHERE roll_no = 'PWTEST02' AND status = 'pending'")).id, 'test');
  assert.equal((await q('POST', '/api/auth/password-login', { rollNo: 'PWTEST02', password: 'Before2026' })).status, 200);
  const det = await ADM('GET', '/api/admin/students/PWTEST02');
  assert.equal(det.body.user.has_password, true);
  assert.ok(!('password_hash' in det.body.user), 'the admin API never returns password hashes');
  assert.equal((await ADM('POST', '/api/admin/users/PWTEST02/password-reset')).status, 200);
  assert.equal((await q('GET', '/api/me')).status, 401, 'reset signs the student out');
  const list = await ADM('GET', '/api/admin/students?q=PWTEST');
  assert.deepEqual(list.body.rows.map((r) => !!r.has_password), [true, false]);
  assert.equal((await q('POST', '/api/auth/password-login', { rollNo: 'PWTEST02', password: 'Before2026' })).body.error, 'NO_PASSWORD');
  const l = await q('POST', '/api/auth/login/start', { rollNo: 'PWTEST02' });
  const lv = await q('POST', '/api/auth/login/verify', { rollNo: 'PWTEST02', otp: l.body.devOtp });
  assert.equal(lv.body.hasPassword, false);
  assert.equal((await q('POST', '/api/auth/password', { password: 'Firstpw2026' })).status, 200, 'no current password needed right after a code login');
  assert.equal((await client()('POST', '/api/auth/password-login', { rollNo: 'PWTEST02', password: 'Firstpw2026' })).status, 200);

});

test('proctoring: events are logged, violations counted, a second tab is flagged, the limit auto-submits from the answers', async () => {
  const now = Date.now();
  for (const r of ['PRTEST01', 'PRTEST02']) {
    await db.run("INSERT INTO students_master (roll_no, name, phone, batch, email, active, source, updated_at) VALUES (?, ?, '', 'A', '', 1, 'admin', ?) ON CONFLICT (roll_no) DO NOTHING", r, 'Pr ' + r, now);
  }
  const P = client();
  await signup(P, 'PRTEST01', '9222200001');
  const boot = await P('GET', '/api/bootstrap');
  assert.deepEqual(boot.body.sprint.proctor, { enabled: true, fullscreen: true, maxViolations: 3, blockCopy: true });
  assert.equal((await P('POST', '/api/sprint/events', { instance: 'tab1', events: [{ type: 'start' }] })).body.error, 'NOT_STARTED');
  assert.equal((await P('POST', '/api/sprint/start')).status, 200);
  let r = await P('POST', '/api/sprint/events', { instance: 'tab1', events: [{ type: 'start', detail: 'screen 1920×1080' }, { type: 'copy' }, { type: 'bogus' }, { type: 'tab_hidden' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.violations, 1);
  assert.equal(r.body.status, 'running');
  // heartbeats only: nothing stored
  const before = (await db.one("SELECT COUNT(*) AS n FROM attempt_events WHERE roll_no = 'PRTEST01'")).n;
  await P('POST', '/api/sprint/events', { instance: 'tab1', events: [{ type: 'hb' }] });
  assert.equal((await db.one("SELECT COUNT(*) AS n FROM attempt_events WHERE roll_no = 'PRTEST01'")).n, before);
  // a second page sending activity while the first is alive → multi_instance violation
  r = await P('POST', '/api/sprint/events', { instance: 'tab2', events: [{ type: 'resume' }] });
  assert.equal(r.body.violations, 2);
  // third violation reaches the limit (3): submitted with the answers sent in the same report
  const answers = { mcq: { 0: Q[0].c, 1: Q[1].c } };
  r = await P('POST', '/api/sprint/events', { instance: 'tab1', events: [{ type: 'fs_exit' }], answers });
  assert.equal(r.body.status, 'submitted', JSON.stringify(r.body));
  assert.equal(r.body.attempt.result.score, 2);
  assert.equal(r.body.attempt.result.endedByViolations, true);
  const id = (await db.one("SELECT id FROM attempts WHERE roll_no = 'PRTEST01'")).id;
  const det = await ADM('GET', '/api/admin/attempts/' + id);
  assert.equal(det.body.proctor.violations, 3);
  assert.equal(det.body.proctor.multi, true);
  assert.equal(det.body.proctor.endedBy, 'violations');
  assert.deepEqual(det.body.proctor.events.map((e) => e.type), ['start', 'copy', 'tab_hidden', 'resume', 'multi_instance', 'fs_exit', 'submit']);
  const list = await ADM('GET', '/api/admin/attempts?flagged=1');
  assert.ok(list.body.rows.some((x) => x.roll_no === 'PRTEST01' && x.proctor.violations === 3));
  // after submitting, reports are accepted but change nothing
  assert.equal((await P('POST', '/api/sprint/events', { instance: 'tab1', events: [{ type: 'tab_hidden' }] })).body.status, 'submitted');

  // limit 0 = never auto-submit; proctoring settings are validated
  assert.equal((await ADM('PATCH', '/api/admin/settings', { proctor_max_violations: -1 })).status, 400);
  assert.equal((await ADM('PATCH', '/api/admin/settings', { proctor_max_violations: 0, proctor_fullscreen: false })).status, 200);
  const Q2 = client();
  await signup(Q2, 'PRTEST02', '9222200002');
  assert.equal((await Q2('GET', '/api/bootstrap')).body.sprint.proctor.fullscreen, false);
  await Q2('POST', '/api/sprint/start');
  for (let i = 0; i < 5; i++) r = await Q2('POST', '/api/sprint/events', { instance: 'x', events: [{ type: 'window_blur' }] });
  assert.equal(r.body.status, 'running');
  assert.equal(r.body.violations, 5);
  await ADM('PATCH', '/api/admin/settings', { proctor_max_violations: 3, proctor_fullscreen: true });
});

test('practice analytics: attempts, correct answers and option spread per question; coding solves', async () => {
  const cat = JSON.parse(fs.readFileSync(path.join(here, '..', 'generated', 'practice.json'), 'utf8'));
  assert.ok(cat.quiz.length > 50 && cat.code.length > 10, 'practice catalogue extracted at build time');
  const q0 = cat.quiz.find((q) => !Array.isArray(q.c)), wrong = (q0.c + 1) % q0.o.length;
  const S1 = client(), S2 = client();
  await login(S1, 'PRTEST01'); await login(S2, 'PRTEST02');
  assert.equal((await S1('PUT', '/api/progress', { data: { pPick: { [q0.gi]: q0.c }, solved: { [cat.code[0].id]: true } } })).status, 200);
  assert.equal((await S2('PUT', '/api/progress', { data: { pPick: { [q0.gi]: wrong } } })).status, 200);
  const d = await ADM('GET', '/api/admin/practice?fresh=1');
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const q = d.body.quiz.find((x) => x.gi === q0.gi);
  assert.equal(q.attempted, 2);
  assert.equal(q.correct, 1);
  assert.equal(q.picks[q0.c], 1); assert.equal(q.picks[wrong], 1);
  assert.equal(d.body.code.find((c) => c.id === cat.code[0].id).solved, 1);
  assert.ok(d.body.active >= 2);
  assert.ok(d.body.topics.some((t) => t.sess === q0.sess && t.attempts >= 2));
  const one = await ADM('GET', '/api/admin/practice/' + q0.gi);
  assert.deepEqual(one.body.students.filter((s) => /^PRTEST/.test(s.roll_no)).map((s) => [s.roll_no, s.correct]), [['PRTEST01', true], ['PRTEST02', false]]);
  assert.equal((await client()('GET', '/api/admin/practice')).status, 401);
});

test('help page and landing info are public; info shows the Sprint, rules and units but no answers', async () => {
  const c = client();
  const h = await c('GET', '/help');
  assert.equal(h.status, 200);
  assert.match(h.text, /How the <span>Sprint<\/span> works/);
  assert.match((await c('GET', '/login')).text, /What to do as a mentor/);
  const i = await c('GET', '/api/info');
  assert.equal(i.status, 200);
  assert.equal(i.body.sprint.questions, Q.length);
  assert.equal(i.body.units.length, 6);
  assert.ok(i.body.units.every((u) => u.title && ['pf', 'genai'].includes(u.course)));
  assert.equal(typeof i.body.proctor.maxViolations, 'number');
  assert.ok(!/"c":|"tests":/.test(i.text), 'no answers in public info');
});

test('simple login: NIAT ID + name (any case, dots, word order); account created on first login; every login recorded', async () => {
  await db.run("INSERT INTO students_master (roll_no, name, phone, batch, email, active, source, updated_at) VALUES ('SIMPLE01', 'Ravi Teja K.', '', 'B', '', 1, 'admin', ?) ON CONFLICT (roll_no) DO NOTHING", Date.now());
  assert.equal((await client()('GET', '/api/info')).body.loginMode, 'simple', 'simple is the default for the initial roll-out');
  const c = client();
  assert.equal((await c('POST', '/api/auth/name-login', { rollNo: 'SIMPLE01', name: 'Ravi' })).body.error, 'BAD_LOGIN');
  assert.equal((await c('POST', '/api/auth/name-login', { rollNo: 'SIMPLE99', name: 'Ravi Teja K' })).body.error, 'BAD_LOGIN', 'unknown IDs get the same answer');
  const ok = await c('POST', '/api/auth/name-login', { rollNo: 'simple01', name: '  k teja RAVI ' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await c('GET', '/api/me')).body.rollNo, 'SIMPLE01');
  assert.equal((await db.one("SELECT COUNT(*) AS n FROM users WHERE roll_no = 'SIMPLE01'")).n, 1);
  assert.equal((await db.one("SELECT method FROM student_logins WHERE roll_no = 'SIMPLE01'")).method, 'name');
  // a disabled account stays out
  await ADM('POST', '/api/admin/users/SIMPLE01/status', { status: 'disabled' });
  assert.equal((await client()('POST', '/api/auth/name-login', { rollNo: 'SIMPLE01', name: 'Ravi Teja K' })).body.error, 'ACCOUNT_DISABLED');
  await ADM('POST', '/api/admin/users/SIMPLE01/status', { status: 'active' });
  // secure mode turns it off
  assert.equal((await ADM('PATCH', '/api/admin/settings', { student_login_mode: 'secure' })).status, 200);
  assert.equal((await client()('POST', '/api/auth/name-login', { rollNo: 'SIMPLE01', name: 'Ravi Teja K' })).body.error, 'MODE');
  assert.equal((await client()('GET', '/api/info')).body.loginMode, 'secure');
  await ADM('PATCH', '/api/admin/settings', { student_login_mode: 'simple' });
});

test('student analytics: active time, unit clicks, video watched, logins per student; super admin only', async () => {
  const c = client();
  await c('POST', '/api/auth/name-login', { rollNo: 'SIMPLE01', name: 'Ravi Teja K' });
  const r = await c('POST', '/api/activity', { items: [
    { area: 'learn', item: 'tp-nested', step: 'watch', ms: 90000, opens: 2, videoMs: 80000, videoPct: 85 },
    { area: 'learn', item: 'tp-nested', step: 'play', ms: 120000, opens: 1 },
    { area: 'practice', item: 'For Loop', ms: 60000, opens: 1 },
    { area: 'learn', item: 'tp-forloop', step: 'watch', ms: 99999999, opens: 1 },
    { area: 'home', item: '', ms: 45000, opens: 1 },
    { area: 'hacking', item: 'x', ms: 1000 } ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.saved, 5, 'unknown areas are dropped');
  // a submitted Sprint test: its time is the attempt's own clock (10 minutes), not portal activity
  const t0 = Date.now() - 15 * 60000;
  await db.run(`INSERT INTO attempts (sprint_id, roll_no, status, started_at, deadline_at, submitted_at, used_ms, updated_at)
    VALUES ('analytics-time', 'SIMPLE01', 'submitted', ?, ?, ?, 600000, ?)`, t0, t0 + 20 * 60000, t0 + 600000, Date.now());
  await c('POST', '/api/activity', { items: [{ area: 'learn', item: 'tp-nested', step: 'watch', ms: 30000, opens: 1, videoPct: 60 }] });
  const row = await db.one("SELECT ms, opens, video_pct FROM activity WHERE roll_no = 'SIMPLE01' AND item = 'tp-nested' AND step = 'watch'");
  assert.deepEqual([Number(row.ms), row.opens, row.video_pct], [120000, 3, 85], 'summed per day; video keeps the furthest point');
  assert.equal(Number((await db.one("SELECT ms FROM activity WHERE roll_no = 'SIMPLE01' AND item = 'tp-forloop'")).ms), 300000, 'one report row is capped at 5 minutes');
  await c('PUT', '/api/progress', { data: { stepDone: { 'pf-0-0:watch': true, 'pf-0-0:play': true, 'pf-0-0:read': true } } });

  const o = await ADM('GET', '/api/admin/analytics/overview?days=7');
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const u = o.body.units.find((x) => x.id === 'tp-nested');
  assert.equal(u.students >= 1 && u.opens >= 4, true);
  assert.equal(u.steps.watch.videoPct, 85);
  assert.ok(u.done.all3 >= 1, 'finished steps map to the unit');
  assert.ok(o.body.areas.find((a) => a.area === 'practice').ms >= 60000);
  const list = await ADM('GET', '/api/admin/analytics/students?q=SIMPLE01');
  const me = list.body.rows[0];
  assert.equal(me.roll_no, 'SIMPLE01');
  assert.equal(me.units_opened, 2); assert.equal(me.units_completed, 1); assert.ok(me.logins >= 2);
  assert.equal(me.sprint_ms, 600000);
  assert.equal(me.ms, 120000 + 120000 + 60000 + 300000 + 600000, 'time on units = Learn + Practice + Sprint; Home is not counted');
  assert.equal(me.portal_ms, me.ms + 45000, 'time on portal also counts Home');
  const det = await ADM('GET', '/api/admin/analytics/students/SIMPLE01');
  assert.equal(det.body.totals.ms, me.ms, 'the student page shows the same time on units');
  assert.equal(det.body.totals.portalMs, me.portal_ms, 'and the same time on portal');
  assert.equal(det.body.totals.sprintMs, 600000);
  assert.equal(det.body.areas.find((a) => a.area === 'home').counted, false);
  assert.equal(det.body.units.find((x) => x.id === 'tp-nested').steps.play.ms, 120000);
  assert.ok(det.body.logins.length >= 2);
  assert.equal(det.body.practice.find((t) => t.sess === 'For Loop').ms, 60000);
  const csv = await ADM('GET', '/api/admin/export/activity.csv?days=7');
  assert.match(csv.text, /SIMPLE01/);
  assert.match(csv.text, /portal_minutes,unit_minutes/);
  assert.equal((await c('GET', '/api/admin/analytics/overview')).status, 401);
  await db.run("DELETE FROM attempts WHERE sprint_id = 'analytics-time'");
});

test('Sprint questions: per-Sprint sets managed by admins, locked once students start; grading and the review use them', async () => {
  const cur = (await ADM('GET', '/api/admin/settings')).body.sprint;
  const b0 = await ADM('GET', '/api/admin/sprints/' + cur.id + '/questions');
  assert.equal(b0.body.source, 'builtin');
  assert.equal(b0.body.questions.length, Q.length);
  // build a set for a new Sprint
  const S = 'qtest-1', base = '/api/admin/sprints/' + S + '/questions';
  assert.equal((await ADM('POST', base + '/copy', { from: 'builtin' })).body.count, Q.length);
  assert.equal((await ADM('POST', base + '/copy', { from: 'builtin' })).body.error, 'NOT_EMPTY');
  assert.equal((await ADM('POST', base, { q: 'x', options: ['only one'], correct: 0, course: 'pf' })).body.error, 'BAD_QUESTION');
  assert.equal((await ADM('POST', base, { q: 'x', options: ['a', 'b'], correct: 0, course: 'genai', unit: 'tp-nested' })).body.error, 'BAD_QUESTION', 'unit must belong to the course');
  const add = await ADM('POST', base, { q: 'Which keyword starts a nested condition?', options: ['loop', 'for', 'while', 'if'], correct: 3, course: 'pf', unit: 'tp-nested' });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const tmp = await ADM('POST', base, { q: 'Temporary', options: ['a', 'b'], correct: 1, course: 'genai' });
  const edited = await ADM('PUT', base + '/' + tmp.body.question.id, { q: 'Temporary (edited)', options: ['a', 'b', 'c'], correct: 2, course: 'genai' });
  assert.equal(edited.body.question.c, 2);
  assert.equal((await ADM('DELETE', base + '/' + tmp.body.question.id)).status, 200);
  let list = (await ADM('GET', base)).body;
  assert.equal(list.source, 'custom'); assert.equal(list.questions.length, Q.length + 1);
  // move the new question to the top
  const ids = list.questions.map((q) => q.id); ids.unshift(ids.pop());
  assert.equal((await ADM('POST', base + '/reorder', { ids })).status, 200);
  assert.equal((await ADM('POST', base + '/reorder', { ids: ids.slice(1) })).body.error, 'BAD_ORDER');
  list = (await ADM('GET', base)).body;
  assert.equal(list.questions[0].q, 'Which keyword starts a nested condition?');
  assert.ok((await ADM('GET', '/api/admin/sprints')).body.sprints.some((s) => s.id === S && s.questions === Q.length + 1));

  // an admin preview does not lock the set
  const S2base = '/api/admin/sprints/qtest-2/questions';
  await ADM('PATCH', '/api/admin/settings', { sprint_id: 'qtest-2' });
  await ADM('POST', S2base, { q: 'Preview me', options: ['a', 'b'], correct: 0, course: 'pf' });
  assert.equal((await ADM('POST', '/api/sprint/start')).status, 200);
  assert.equal((await ADM('POST', S2base, { q: 'Still editable', options: ['a', 'b'], correct: 0, course: 'pf' })).status, 200);

  // make qtest-1 the live Sprint, review after close
  const now = Date.now();
  assert.equal((await ADM('PATCH', '/api/admin/settings', { sprint_id: S, sprint_open: new Date(now - 60000).toISOString(), sprint_close: new Date(now + 3600000).toISOString(), review_mode: 'after_close' })).status, 200);
  const c = client();
  await c('POST', '/api/auth/name-login', { rollNo: 'SIMPLE01', name: 'Ravi Teja K' });
  const boot = await c('GET', '/api/bootstrap');
  assert.equal(boot.body.sprint.types.length, Q.length + 1);
  assert.equal(boot.body.sprint.reviewMode, 'after_close');
  const st = await c('POST', '/api/sprint/start');
  assert.equal(st.body.attempt.questions[0].o.length, 4);
  assert.ok(st.body.attempt.questions.every((q) => q.c === undefined), 'no answers before submitting');
  assert.equal((await ADM('POST', base, { q: 'Too late', options: ['a', 'b'], correct: 0, course: 'pf' })).body.error, 'LOCKED');
  assert.equal((await ADM('PUT', base + '/' + list.questions[0].id, { q: 'Changed', options: ['a', 'b'], correct: 0, course: 'pf' })).body.error, 'LOCKED');
  assert.equal((await c('GET', '/api/sprint/review')).body.reason, 'not_submitted');
  // all right except question 2 (wrong on purpose)
  const mcq = {}; list.questions.forEach((q, i) => { if (q.type === 'mcq') mcq[i] = i === 1 ? (q.c + 1) % q.o.length : q.c; });
  const sub = await c('POST', '/api/sprint/submit', { mcq });
  assert.equal(sub.body.attempt.result.score, Q.length, 'graded with this Sprint\'s set, a 4-option question included');

  let rv = (await c('GET', '/api/sprint/review')).body;
  assert.equal(rv.open, false); assert.equal(rv.reason, 'before_close');
  assert.ok(!JSON.stringify(rv).includes('"correct"'), 'no answers before the review opens');
  await ADM('PATCH', '/api/admin/settings', { review_mode: 'hidden' });
  assert.equal((await c('GET', '/api/sprint/review')).body.reason, 'hidden');
  await ADM('PATCH', '/api/admin/settings', { review_mode: 'after_submit' });
  rv = (await c('GET', '/api/sprint/review')).body;
  assert.equal(rv.open, true);
  assert.equal(rv.items.length, Q.length + 1);
  assert.deepEqual([rv.items[0].pick, rv.items[0].correct, rv.items[0].right, rv.items[0].unitTitle], [3, 3, true, 'Nested Conditional Statements']);
  assert.equal(rv.items[1].right, false);
  const nested = rv.byUnit.find((u) => u.unit === 'tp-nested');
  assert.deepEqual([nested.right, nested.of], [1, 1]);
  assert.equal(rv.byCourse.reduce((n, x) => n + x.right, 0), Q.length);
  // after_close opens once the Sprint has closed
  await ADM('PATCH', '/api/admin/settings', { review_mode: 'after_close', sprint_close: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await c('GET', '/api/sprint/review')).body.open, true);
  assert.equal((await client()('GET', '/api/sprint/review')).status, 401);
  assert.equal((await client()('GET', '/review')).status, 200);
  await ADM('PATCH', '/api/admin/settings', { sprint_id: cur.id, sprint_open: cur.open, sprint_close: cur.close });
});

test('super admin tests any Sprint at any time: preview another set, take it outside the window, restart; students unaffected', async () => {
  const before = (await ADM('GET', '/api/admin/settings')).body.sprint;
  await ADM('PATCH', '/api/admin/settings', { sprint_open: new Date(Date.now() + 86400000).toISOString(), sprint_close: new Date(Date.now() + 2 * 86400000).toISOString() });
  const live = (await ADM('GET', '/api/admin/settings')).body.sprint;
  await ADM('POST', '/api/admin/sprints/pv-1/questions', { q: 'Preview only?', options: ['yes', 'no'], correct: 0, course: 'pf' });
  const set = await ADM('POST', '/api/admin/preview', { sprintId: 'pv-1' });
  assert.equal(set.body.previewSprint, 'pv-1');
  assert.ok((await ADM('GET', '/api/admin/sprints')).body.sprints.some((s) => s.id === 'pv-1'));
  const boot = await ADM('GET', '/api/bootstrap');
  assert.equal(boot.body.sprint.previewOf, 'pv-1');
  assert.equal(boot.body.sprint.types.length, 1);
  const st = await ADM('POST', '/api/sprint/start');
  assert.equal(st.status, 200, 'admins start before the window opens');
  assert.equal(st.body.attempt.questions[0].q, 'Preview only?');
  const sub = await ADM('POST', '/api/sprint/submit', { mcq: { 0: 0 } });
  assert.equal(sub.body.attempt.result.score, 1);
  assert.equal((await ADM('GET', '/api/sprint/review')).body.open, true, 'admins always see the review');
  assert.equal((await ADM('POST', '/api/sprint/restart')).status, 200);
  assert.equal((await ADM('GET', '/api/bootstrap')).body.attempt.status, 'none', 'restart gives a fresh attempt');
  // students still get the live Sprint, closed
  const c = client();
  await c('POST', '/api/auth/name-login', { rollNo: 'SIMPLE01', name: 'Ravi Teja K' });
  const sb = await c('GET', '/api/bootstrap');
  assert.equal(sb.body.sprint.id, live.id); assert.equal(sb.body.sprint.previewOf, null);
  assert.equal((await c('POST', '/api/sprint/start')).body.error, 'NOT_OPEN');
  assert.equal((await c('POST', '/api/sprint/restart')).status, 403);
  assert.equal(Number((await db.one("SELECT COUNT(*) AS n FROM attempts WHERE sprint_id = 'pv-1' AND roll_no NOT LIKE 'ADMIN-%'")).n), 0);
  // back to the live Sprint
  assert.equal((await ADM('POST', '/api/admin/preview', { sprintId: '' })).body.previewSprint, null);
  assert.equal((await ADM('GET', '/api/bootstrap')).body.sprint.id, live.id);
  await ADM('PATCH', '/api/admin/settings', { sprint_open: before.open, sprint_close: before.close });
});

test('business metrics: every value matches a hand-computed dataset; TEST accounts never count; nothing is made up', async () => {
  const { istDay } = await import('../analytics.js');
  const DAYMS = 86400000, now = Date.now(), today = istDay(now);
  const day = (n) => istDay(now - n * DAYMS);
  // Isolate the dataset: other students from earlier tests are set inactive for this test (test database only).
  const others = (await db.all("SELECT roll_no FROM students_master WHERE active = 1 AND roll_no NOT LIKE 'BM%'")).map((r) => r.roll_no);
  await db.run("UPDATE students_master SET active = 0 WHERE roll_no NOT LIKE 'BM%'");
  try {
    for (const [r, name, batch] of [['BM01', 'Bm One', 'R'], ['BM02', 'Bm Two', 'R'], ['BM03', 'Bm Three', 'R'], ['BM04', 'Bm Four', 'R'], ['BMT1', 'Bm Test', 'TEST']]) {
      await db.run("INSERT INTO students_master (roll_no, name, phone, batch, email, active, source, updated_at) VALUES (?, ?, '', ?, '', 1, 'admin', ?)", r, name, batch, now);
    }
    for (const r of ['BM01', 'BM02', 'BM03', 'BMT1']) await db.run("INSERT INTO users (roll_no, phone, status, created_at) VALUES (?, '', 'active', ?)", r, now);
    const act = (r, d, area, item, step, ms, opens, vms = 0, vpct = 0) => db.run('INSERT INTO activity (roll_no, day, area, item, step, ms, opens, video_ms, video_pct, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', r, d, area, item, step, ms, opens, vms, vpct, now);
    await act('BM01', day(8), 'home', '', '', 30000, 1);
    await act('BM01', day(7), 'learn', 'tp-nested', 'watch', 600000, 2, 300000, 90);
    await act('BM01', today, 'learn', 'tp-nested', 'play', 300000, 1);
    await act('BM01', today, 'practice', 'Nested Conditional Statements', '', 120000, 1);
    await act('BM02', day(1), 'learn', 'tp-forloop', 'watch', 60000, 1);
    await act('BMT1', today, 'learn', 'tp-nested', 'watch', 999999, 9);
    const cat = JSON.parse(fs.readFileSync(path.join(here, '..', 'generated', 'practice.json'), 'utf8'));
    const nq = cat.quiz.filter((q) => q.sess === 'Nested Conditional Statements' && !Array.isArray(q.c));
    const prog = (r, data) => db.run('INSERT INTO progress (roll_no, data, updated_at) VALUES (?, ?, ?)', r, JSON.stringify(data), now);
    await prog('BM01', { stepDone: { 'pf-0-0:watch': true, 'pf-0-0:play': true, 'pf-0-0:read': true, 'pf-1-0:watch': true },
      pPick: { [nq[0].gi]: nq[0].c, [nq[1].gi]: (nq[1].c + 1) % nq[1].o.length }, solved: { [cat.code[0].id]: true } });
    await prog('BMT1', { stepDone: { 'pf-0-0:watch': true, 'pf-0-0:play': true, 'pf-0-0:read': true } });
    // a Sprint with 2 questions tagged to the Nested unit (correct answer: option A)
    for (const t of ['N1', 'N2']) await ADM('POST', '/api/admin/sprints/bm-sprint/questions', { q: 'Nested ' + t, options: ['a', 'b'], correct: 0, course: 'pf', unit: 'tp-nested' });
    const att = (r, status, total, answers) => db.run(`INSERT INTO attempts (sprint_id, roll_no, status, started_at, deadline_at, updated_at, total, max_total, answers, text_reviewed, submitted_at)
      VALUES ('bm-sprint', ?, ?, ?, ?, ?, ?, 10, ?, 1, ?)`, r, status, now - 3600000, now, now, total, JSON.stringify({ mcq: answers }), status === 'submitted' ? now : null);
    await att('BM01', 'submitted', 5, { 0: 0, 1: 1 });
    await att('BM02', 'submitted', 3, { 0: 0, 1: 0 });
    await att('BM03', 'running', null, {});
    await att('BMT1', 'submitted', 10, { 0: 0, 1: 0 });

    const r = await ADM('GET', '/api/admin/analytics/business?sprint=bm-sprint&fresh=1');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const get = (stage, label) => r.body.funnel.find((f) => f.key === stage).metrics.find((m) => m.label === label);
    const v = (stage, label) => get(stage, label).value;
    // Reach
    assert.equal(v('reach', 'Students in the list'), 4, 'TEST excluded');
    assert.equal(v('reach', 'Registered users'), 3);
    assert.equal(v('reach', 'Activated users'), 2);
    // Activity (data spans 9 days: day -8 .. today)
    assert.equal(v('activity', 'DAU'), 1);
    assert.equal(v('activity', 'WAU'), 2);
    assert.equal(v('activity', 'MAU'), 2);
    assert.equal(v('activity', 'DAU/MAU'), 22.2, 'average DAU 4/9 divided by MAU 2');
    assert.equal(v('activity', 'Sessions/user'), null);
    assert.match(get('activity', 'Sessions/user').reason, /none yet/);
    // Learning
    assert.equal(v('learning', 'Learning hours/user'), 540000, 'study time 1,080,000 ms over 2 students');
    assert.equal(v('learning', 'Content starts'), 3);
    assert.equal(v('learning', 'Content completion rate'), 44.4, '4 of 9 steps');
    assert.equal(v('learning', 'Lesson completion rate'), 33.3, '1 of 3 started units');
    // Practice
    assert.equal(v('practice', 'Questions attempted'), 2);
    assert.equal(v('practice', 'Practice attempts/user'), 3);
    assert.equal(v('practice', 'Practice completion rate'), Math.round(2 / cat.quiz.length * 1000) / 10);
    assert.equal(v('practice', 'Re-attempt rate'), null);
    assert.match(get('practice', 'Re-attempt rate').reason, /first answer/);
    // Assessment (pass mark 40%)
    assert.equal(v('assessment', 'Assessment attempts'), 3);
    assert.equal(v('assessment', 'Submission rate'), 66.7);
    assert.equal(v('assessment', 'Avg. score'), 40);
    assert.equal(v('assessment', 'Pass rate'), 50);
    // Retention
    assert.equal(v('retention', 'D1 retention'), 50, 'BM01 came back the next day, BM02 did not');
    assert.equal(v('retention', 'D7 retention'), 0);
    assert.equal(v('retention', 'D30 retention'), null);
    assert.equal(v('retention', 'Weekly retention'), null, 'needs 14 days of data');
    assert.equal(v('retention', 'Inactive 7+ days'), 0);
    // Completion
    assert.equal(v('completion', 'Course completion: Programming Foundations'), 0);
    assert.equal(v('completion', 'Module completion'), 8.3, 'one of 6 units for BM01, none for BM02');
    assert.equal(v('completion', 'Time to completion (unit)'), null);
    // Unit table
    const u = r.body.units.find((x) => x.id === 'tp-nested');
    assert.deepEqual([u.started, u.done.watch, u.done.play, u.done.read, u.completed, u.completionRate], [1, 1, 1, 1, 1, 100]);
    assert.deepEqual([u.time.watch.avgMs, u.time.play.avgMs, u.video.avgPct, u.video.avgMs], [600000, 300000, 90, 300000]);
    assert.deepEqual([u.practice.topic, u.practice.students, u.practice.accuracy], ['Nested Conditional Statements', 1, 50]);
    assert.deepEqual([u.assessment.questions, u.assessment.submitted, u.assessment.correctPct], [2, 2, 75]);
    assert.equal(r.body.units.find((x) => x.id === 'tp-forloop').started, 2);
    assert.equal(r.body.units.find((x) => x.id === 'tp-genai-foundations').practice.topic, 'Gen AI Foundations & Capabilities');

    // New tracking: a visit + unit start event, and step events from a progress save (progress stored exactly as sent)
    const c = client();
    assert.equal((await c('POST', '/api/auth/name-login', { rollNo: 'BM02', name: 'Bm Two' })).status, 200);
    await c('POST', '/api/activity', { session: { id: 'visit-abc123', startedAt: now - 60000 }, items: [{ area: 'learn', item: 'tp-strings', step: 'watch', ms: 30000, opens: 1, firstAt: now - 50000 }] });
    const sent = { stepDone: { 'pf-2-0:watch': true }, pPick: {} };
    await c('PUT', '/api/progress', { data: sent });
    assert.equal((await db.one("SELECT data FROM progress WHERE roll_no = 'BM02'")).data, JSON.stringify(sent));
    const ev = await db.all("SELECT unit_id, kind FROM unit_events WHERE roll_no = 'BM02' ORDER BY kind");
    assert.deepEqual(ev.map((e) => e.unit_id + ':' + e.kind), ['tp-strings:start', 'tp-strings:watch']);
    const s = await db.one("SELECT roll_no, active_ms FROM activity_sessions WHERE session_id = 'BM02:visit-abc123'");
    assert.deepEqual([s.roll_no, Number(s.active_ms)], ['BM02', 30000]);
    const r2 = await ADM('GET', '/api/admin/analytics/business?sprint=bm-sprint&fresh=1');
    const sess = r2.body.funnel.find((f) => f.key === 'activity').metrics;
    assert.equal(sess.find((m) => m.label === 'Sessions/user').value, 1);
    assert.equal(sess.find((m) => m.label === 'Avg. session duration').value, 30000);
  } finally {
    for (const r of others) await db.run('UPDATE students_master SET active = 1 WHERE roll_no = ?', r);
  }
});

test('student photo: required to register, carried to the account on approval, admins see it, students change their own', async () => {
  // registration without a photo is refused before the code is even checked
  const c = client();
  const r = await c('POST', '/api/auth/register/verify', { rollNo: 'NIAT24009', otp: '123456', phone: '9000000009', password: 'Sprint2026' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'PHOTO_REQUIRED');
  assert.equal((await c('POST', '/api/auth/register/verify', { rollNo: 'NIAT24009', otp: '123456', phone: '9000000009', password: 'Sprint2026', photo: 'data:text/html;base64,PGI+' })).body.error, 'PHOTO_INVALID');

  // A registered with a photo: approval copied it to the account
  const boot = await A('GET', '/api/bootstrap');
  assert.ok(boot.body.user.photoAt > 0, 'bootstrap tells the portal the student has a photo');
  const mine = await fetch(base + '/api/me/photo', { headers: { cookie: A.cookie() } });
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get('content-type'), 'image/jpeg');
  assert.equal((await ADM('GET', '/api/admin/approvals?status=approved')).body.rows.find((x) => x.roll_no === 'NIAT24001').has_photo, 1);
  assert.equal((await ADM('GET', '/api/admin/students/NIAT24001')).body.photoAt > 0, true);
  const adm = await fetch(base + '/api/admin/photos/student/NIAT24001', { headers: { cookie: ADM.cookie() } });
  assert.equal(adm.status, 200);
  assert.equal((await fetch(base + '/api/admin/photos/student/NIAT24001', { headers: { cookie: A.cookie() } })).status, 401, 'students cannot read admin photo URLs');

  // changing it: bad data refused, a new photo bumps the stamp
  assert.equal((await A('PUT', '/api/me/photo', { photo: '' })).body.error, 'PHOTO_REQUIRED');
  assert.equal((await A('PUT', '/api/me/photo', { photo: 'data:image/jpeg;base64,' + 'A'.repeat(500 * 1024) })).status, 413);
  const up = await A('PUT', '/api/me/photo', { photo: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.ok(up.body.photoAt >= boot.body.user.photoAt);
  assert.equal((await fetch(base + '/api/me/photo', { headers: { cookie: A.cookie() } })).headers.get('content-type'), 'image/png');
  assert.equal((await ADM('PUT', '/api/me/photo', { photo: PHOTO })).status, 403, 'admins have no student photo');
});

test('courses & topics: admins add courses and topics; the portal gets them; edit, reorder, upload, delete', async () => {
  assert.equal((await A('POST', '/api/admin/content/courses', { name: 'Hack' })).status, 401, 'students cannot manage content');
  const co = await ADM('POST', '/api/admin/content/courses', { name: 'Data Structures 101' });
  assert.equal(co.status, 200, JSON.stringify(co.body));
  assert.equal(co.body.id, 'datastructures', 'course ids are letters only (progress keys and analytics depend on it)');
  assert.equal((await ADM('POST', '/api/admin/content/courses', { name: 'Data Structures' })).body.id, 'datastructuresa', 'ids never clash');
  assert.equal((await ADM('POST', '/api/admin/content/courses', { name: ' ' })).body.error, 'BAD_NAME');

  const t1 = await ADM('POST', '/api/admin/content/units', { course: 'datastructures', title: 'Arrays', goal: 'Watch. An array keeps items in order.', orientation: 'portrait' });
  assert.equal(t1.status, 200, JSON.stringify(t1.body));
  assert.equal(t1.body.id, 'u-arrays');
  const t2 = await ADM('POST', '/api/admin/content/units', { course: 'datastructures', title: 'Linked Lists' });
  assert.equal((await ADM('POST', '/api/admin/content/units', { course: 'datastructures', title: 'Arrays' })).body.id, 'u-arrays-2', 'unit ids never clash');
  assert.equal((await ADM('POST', '/api/admin/content/units', { course: 'nope', title: 'X' })).body.error, 'BAD_COURSE');
  const pfTopic = await ADM('POST', '/api/admin/content/units', { course: 'pf', title: 'While Loop' });
  assert.equal(pfTopic.status, 200);

  // the portal: new course + its topics after the built-in ones, as Watch → Play → Read units
  let boot = await A('GET', '/api/bootstrap');
  assert.ok(boot.body.courses.some((c) => c.id === 'datastructures' && c.name === 'Data Structures 101'));
  let ds = boot.body.units.units.filter((u) => u.course === 'datastructures').map((u) => u.id);
  assert.deepEqual(ds, ['u-arrays', 'u-linked-lists', 'u-arrays-2']);
  const arr = boot.body.units.units.find((u) => u.id === 'u-arrays');
  assert.equal(arr.lessons[0].kind, 'video');
  assert.equal(arr.lessons[0].watch.orientation, 'portrait');
  const pf = boot.body.units.units.filter((u) => u.course === 'pf').map((u) => u.id);
  assert.equal(pf[pf.length - 1], pfTopic.body.id, 'topics added to a built-in course come after its units');

  // the admin catalog lists them, and their steps take uploads like any unit
  const media = await ADM('GET', '/api/admin/media');
  assert.ok(media.body.courses.find((c) => c.id === 'datastructures').custom);
  assert.equal(media.body.lessons.find((l) => l.id === 'u-arrays').steps.read.active, 'none');
  assert.equal((await ADM('POST', '/api/admin/media/u-arrays/read/html', { html: '<!doctype html><h1>Array notes</h1>', fileName: 'a.html' })).status, 200);
  boot = await A('GET', '/api/bootstrap');
  assert.match(boot.body.unitContent['u-arrays'].read, /^\/api\/content\/u-arrays\/read\?v=\d+$/);

  // edit and reorder
  assert.equal((await ADM('PATCH', '/api/admin/content/units/u-linked-lists', { title: 'Linked Lists 1' })).status, 200);
  assert.equal((await ADM('POST', '/api/admin/content/units/u-linked-lists/move', { dir: -1 })).status, 200);
  boot = await A('GET', '/api/bootstrap');
  ds = boot.body.units.units.filter((u) => u.course === 'datastructures');
  assert.deepEqual(ds.map((u) => u.id), ['u-linked-lists', 'u-arrays', 'u-arrays-2']);
  assert.equal(ds[0].name, 'Linked Lists 1');
  assert.equal((await ADM('PATCH', '/api/admin/content/units/tp-nested', { title: 'Nested' })).status, 404, 'built-in units are not edited here');
  assert.equal((await ADM('PATCH', '/api/admin/content/courses/datastructures', { name: 'DSA' })).status, 200);

  // delete: a course must be empty; deleting a topic removes its uploads
  assert.equal((await ADM('DELETE', '/api/admin/content/courses/datastructures')).body.error, 'NOT_EMPTY');
  for (const id of ['u-arrays', 'u-arrays-2', 'u-linked-lists', pfTopic.body.id]) assert.equal((await ADM('DELETE', '/api/admin/content/units/' + id)).status, 200);
  assert.equal(await db.one("SELECT COUNT(*) AS n FROM unit_content WHERE unit_id = 'u-arrays'").then((r) => Number(r.n)), 0);
  assert.equal((await ADM('DELETE', '/api/admin/content/courses/datastructures')).status, 200);
  assert.equal((await ADM('DELETE', '/api/admin/content/courses/datastructuresa')).status, 200);
  boot = await A('GET', '/api/bootstrap');
  assert.equal(boot.body.courses.length, 0);
  assert.equal(boot.body.units.units.length, 6);
});

test('built-in courses and topics: a super admin removes them from the portal and restores them; the last topic cannot go', async () => {
  assert.equal((await A('DELETE', '/api/admin/content/builtin/units/tp-forloop')).status, 401, 'students cannot remove content');
  assert.equal((await ADM('DELETE', '/api/admin/content/builtin/units/nope')).status, 404);
  assert.equal((await ADM('DELETE', '/api/admin/content/builtin/units/tp-forloop')).status, 200);
  let boot = await A('GET', '/api/bootstrap');
  assert.ok(!boot.body.units.units.some((u) => u.id === 'tp-forloop'), 'removed topic is gone from the portal');
  assert.deepEqual(boot.body.units.replaced.sort(), ['genai', 'pf'], 'the portal keeps replacing the original lessons');
  let media = await ADM('GET', '/api/admin/media');
  assert.ok(!media.body.lessons.some((l) => l.id === 'tp-forloop'));
  assert.deepEqual(media.body.hidden.units.map((u) => u.id), ['tp-forloop']);

  // remove the whole Programming Foundations course: its units go, and the course is listed as removed
  assert.equal((await ADM('DELETE', '/api/admin/content/builtin/courses/pf')).status, 200);
  boot = await A('GET', '/api/bootstrap');
  assert.ok(!boot.body.units.units.some((u) => u.course === 'pf'));
  assert.deepEqual(boot.body.units.hiddenCourses, ['pf']);
  media = await ADM('GET', '/api/admin/media');
  assert.ok(!media.body.courses.some((c) => c.id === 'pf'));
  assert.deepEqual(media.body.hidden.courses.map((c) => c.id), ['pf']);
  assert.equal((await ADM('POST', '/api/admin/content/units', { course: 'pf', title: 'Loops again' })).body.error, 'BAD_COURSE', 'no new topics in a removed course');

  // the last course with topics cannot be removed
  assert.equal((await ADM('DELETE', '/api/admin/content/builtin/courses/genai')).body.error, 'LAST_TOPIC');

  // restore both
  assert.equal((await ADM('POST', '/api/admin/content/builtin/courses/pf/restore')).status, 200);
  assert.equal((await ADM('POST', '/api/admin/content/builtin/units/tp-forloop/restore')).status, 200);
  assert.equal((await ADM('POST', '/api/admin/content/builtin/units/tp-forloop/restore')).status, 404, 'nothing left to restore');
  boot = await A('GET', '/api/bootstrap');
  assert.equal(boot.body.units.units.length, 6);
  assert.deepEqual(boot.body.units.hiddenCourses, []);
});

test('next Sprint: switched to once, after the current Sprint closes; the Learn page gets its topics', async () => {
  const sp = await import('../sprint.js');
  const keys = ['sprint_id', 'sprint_title', 'sprint_open', 'sprint_close', 'sprint_duration_min', 'sprint_schedule_applied'];
  const saved = {};
  for (const k of keys) saved[k] = await db.getSetting(k, null);
  const next = { id: 'sprint-next-test', title: 'Next One', open: '2030-01-05T17:00:00+05:30', close: '2030-01-05T17:20:00+05:30', durationMin: 20 };
  // current Sprint still open: no switch
  await db.setSetting('sprint_close', new Date(Date.now() + 3600000).toISOString());
  sp.setScheduleForTest(next);
  assert.notEqual((await sp.getSprint()).id, next.id);
  // current Sprint closed: switch once
  await db.setSetting('sprint_close', new Date(Date.now() - 60000).toISOString());
  sp.setScheduleForTest(next);
  const s = await sp.getSprint();
  assert.equal(s.id, next.id);
  assert.equal(s.title, 'Next One');
  assert.equal(s.openMs, Date.parse(next.open));
  assert.equal(s.closeMs, Date.parse(next.close));
  assert.equal(s.durationMin, 20);
  assert.ok(await db.one("SELECT 1 AS x FROM audit_log WHERE action = 'settings.next_sprint_applied' AND target = 'sprint-next-test'"));
  // an admin changing the settings afterwards wins: the switch never runs again for that id
  await db.setSetting('sprint_id', 'admin-choice');
  await db.setSetting('sprint_close', new Date(Date.now() - 60000).toISOString());
  sp.setScheduleForTest(next);
  assert.equal((await sp.getSprint()).id, 'admin-choice');
  sp.setScheduleForTest(null);
  for (const k of keys) {
    if (saved[k] === null) await db.run('DELETE FROM settings WHERE key = ?', k); else await db.setSetting(k, saved[k]);
  }
  db.clearSettingCache();

  const boot = await A('GET', '/api/bootstrap');
  const ns = JSON.parse(fs.readFileSync(path.join(here, '..', 'generated', 'next-sprint.json'), 'utf8'));
  assert.deepEqual(boot.body.nextSprint, ns);
  if (ns) assert.ok(ns.groups.every((g) => g.topics.every((x) => !x.includes('\u2014'))), 'no em dashes in the topic names');
});

test('Sprint question sets per Sprint ID: content/sprint-sets is used for that Sprint, answers stay on the server', async () => {
  const sp = await import('../sprint.js');
  const sets = path.join(here, '..', 'generated', 'sprint-sets');
  for (const f of fs.existsSync(sets) ? fs.readdirSync(sets) : []) {
    const id = f.replace(/\.json$/, ''), qs = await sp.getQuestions(id);
    assert.deepEqual(qs, JSON.parse(fs.readFileSync(path.join(sets, f), 'utf8')));
    const pub = await sp.publicQuestions(id);
    assert.ok(pub.every((q) => q.c === undefined && q.level === undefined), 'no answers or levels in what students get');
  }
  const next = JSON.parse(fs.readFileSync(path.join(here, '..', 'generated', 'sprint-schedule.json'), 'utf8'));
  if (next) {
    const qs = await sp.getQuestions(next.id);
    assert.equal(qs.length, 20, 'the next Sprint has its own 20 questions');
    for (const lv of ['easy', 'medium', 'hard']) assert.ok(qs.filter((q) => q.level === lv).length >= 5, 'mixed difficulty: ' + lv);
    assert.ok(qs.every((q) => !JSON.stringify(q).includes('—')), 'no em dashes');
  }
  assert.notDeepEqual(await sp.getQuestions('some-other-sprint'), await sp.getQuestions(next ? next.id : 'x'));
});

test('leaderboard between Sprints: a new Sprint without results shows the last Sprint with results; nothing is deleted', async () => {
  const before = await A('GET', '/api/leaderboard');
  assert.ok(before.body.participants > 0, 'the current Sprint has results in this suite');
  const oldId = await db.getSetting('sprint_id', null);
  const n0 = Number((await db.one('SELECT COUNT(*) AS n FROM attempts')).n);
  await db.setSetting('sprint_id', 'brand-new-sprint');
  const lb = await A('GET', '/api/leaderboard');
  assert.equal(lb.body.previous, true);
  assert.notEqual(lb.body.sprintId, 'brand-new-sprint', 'the latest Sprint that has results');
  assert.ok(lb.body.participants > 0 && lb.body.rows.length > 0);
  assert.match(lb.body.title, /Last Sprint results/);
  assert.equal(Number((await db.one('SELECT COUNT(*) AS n FROM attempts')).n), n0, 'no attempts removed');
  if (oldId === null) await db.run("DELETE FROM settings WHERE key = 'sprint_id'"); else await db.setSetting('sprint_id', oldId);
  db.clearSettingCache();
  const after = await A('GET', '/api/leaderboard');
  assert.equal(after.body.previous, false);
});

test('University leaderboard: universities come from the master data; ranks restart at #1 within a university', async () => {
  const sp = await import('../sprint.js'), { importStudents } = await import('../students.js'), { forgetSessions } = await import('../auth.js');
  const oldId = await db.getSetting('sprint_id', null), SID = 'uni-board-sprint', now = Date.now();
  await db.setSetting('sprint_id', SID);
  db.clearSettingCache();
  const people = [ // roll, university, total, seconds used
    ['UNI0001', 'Alpha University', 9, 100], ['UNI0002', 'Beta University', 8, 50], ['UNI0003', 'Beta University', 7, 60],
    ['UNI0004', '', 10, 40], [ROLL, 'Alpha University', 5, 30]
  ];
  const oldUni = (await db.one('SELECT university FROM students_master WHERE roll_no = ?', ROLL)).university;
  for (const [roll, uni, total, sec] of people) {
    if (roll === ROLL) await db.run('UPDATE students_master SET university = ? WHERE roll_no = ?', uni, roll);
    else await db.run("INSERT INTO students_master (roll_no, name, phone, batch, email, university, active, source, updated_at) VALUES (?, ?, '', 'B1', '', ?, 1, 'admin', ?)", roll, 'Student ' + roll, uni, now);
    await db.run("INSERT INTO attempts (sprint_id, roll_no, status, started_at, deadline_at, submitted_at, total, max_total, used_ms, updated_at) VALUES (?, ?, 'submitted', ?, ?, ?, ?, 10, ?, ?)",
      SID, roll, now, now + 60000, now, total, sec * 1000, now);
  }
  forgetSessions();
  await sp.clearBoardCache();
  try {
    const all = await A('GET', '/api/leaderboard');
    assert.equal(all.body.participants, 5);
    assert.equal(all.body.rows[0].university, '', 'blank university still on the overall board');
    assert.equal(all.body.me.rank, 5);
    assert.ok(['Alpha University', 'Beta University'].every((u) => all.body.universities.includes(u)));
    assert.ok(!all.body.universities.includes(''), 'blank is not a university');
    assert.equal(all.body.myUniversity, 'Alpha University');

    const alpha = await A('GET', '/api/leaderboard?university=' + encodeURIComponent('Alpha University'));
    assert.equal(alpha.status, 200);
    assert.equal(alpha.body.university, 'Alpha University');
    assert.equal(alpha.body.participants, 2);
    assert.deepEqual(alpha.body.rows.map((r) => r.rank), [1, 2]);
    assert.ok(alpha.body.rows.every((r) => r.university === 'Alpha University'));
    assert.equal(alpha.body.me.rank, 2, 'my rank within my university');

    const beta = await A('GET', '/api/leaderboard?university=' + encodeURIComponent('Beta University'));
    assert.deepEqual(beta.body.rows.map((r) => [r.rank, r.name]), [[1, 'Student UNI0002'], [2, 'Student UNI0003']]);
    assert.equal(beta.body.me, null, 'a student can view another university, unranked there');

    assert.equal((await A('GET', '/api/leaderboard?university=Nowhere')).status, 404);
    const adm = await ADM('GET', '/api/admin/leaderboard?university=' + encodeURIComponent('Beta University'));
    assert.deepEqual(adm.body.rows.map((r) => r.roll_no), ['UNI0002', 'UNI0003']);

    // A new result clears every university board too
    await db.run('UPDATE attempts SET total = 10, used_ms = 1000 WHERE sprint_id = ? AND roll_no = ?', SID, 'UNI0003');
    await sp.clearBoardCache();
    assert.equal((await A('GET', '/api/leaderboard?university=' + encodeURIComponent('Beta University'))).body.rows[0].name, 'Student UNI0003');

    // Import: a "University Name" column fills the field; a sheet without that column keeps it
    let r = await importStudents({ csv: 'NIAT ID,Student Name,University Name\nUNI0001,One,Gamma University\n' }, { source: 'admin', fullSync: false });
    assert.equal(r.error, null);
    assert.equal((await db.one('SELECT university FROM students_master WHERE roll_no = ?', 'UNI0001')).university, 'Gamma University');
    r = await importStudents({ csv: 'NIAT ID,Student Name\nUNI0001,One Renamed\n' }, { source: 'admin', fullSync: false });
    const m = await db.one('SELECT name, university FROM students_master WHERE roll_no = ?', 'UNI0001');
    assert.deepEqual([m.name, m.university], ['One Renamed', 'Gamma University']);
  } finally {
    await db.run('DELETE FROM attempts WHERE sprint_id = ?', SID);
    await db.run("DELETE FROM students_master WHERE roll_no LIKE 'UNI%'");
    await db.run('UPDATE students_master SET university = ? WHERE roll_no = ?', oldUni, ROLL);
    if (oldId === null) await db.run("DELETE FROM settings WHERE key = 'sprint_id'"); else await db.setSetting('sprint_id', oldId);
    db.clearSettingCache();
    forgetSessions();
    await sp.clearBoardCache();
  }
});

test('every page script parses (a syntax error leaves the admin console or portal blank)', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  for (const f of ['admin.html', 'login.html', 'help.html', 'review.html']) {
    const html = fs.readFileSync(path.join(dir, f), 'utf8'), re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(html))) assert.doesNotThrow(() => new vm.Script(m[1], { filename: f }), f);
  }
  assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(dir, 'portal-bridge.js'), 'utf8'), { filename: 'portal-bridge.js' }));
});
