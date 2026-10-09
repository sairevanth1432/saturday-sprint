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

test('master data: university column (the university-wise sheet), split by university, merge keeps stored values', async (t) => {
  const csv = ',NIAT ID,Registered Accounts UID,Student Personal Mail ID,Student mobile number,student names,\n'
    .replace(/^,/, 'University,').replace(/,\n$/, ',Section\n') +
    'ALARD - Pune,UNIV0001,uid-1,a@x.com,9876511111,Alard One,\n' +
    'ALARD - Pune,UNIV0002,uid-2,b@x.com,,Alard Two,\n' +
    'Geeta University - Panipat,UNIV0003,uid-3,c@x.com,9876533333,,S-01\n';
  const pv = await ADM('POST', '/api/admin/import/preview', { csv });
  assert.equal(pv.body.valid, 3, JSON.stringify(pv.body));
  assert.equal(pv.body.sample[0].university, 'ALARD - Pune');
  assert.equal(pv.body.sample[0].email, 'a@x.com', '"Student Personal Mail ID" is the email');
  assert.equal(pv.body.sample[2].batch, 'S-01', '"Section" is the batch');
  assert.deepEqual(pv.body.byUniversity, [['ALARD - Pune', 2], ['Geeta University - Panipat', 1]]);
  // UNIV0003 already has a name; the sheet has none for them: merge keeps the stored name
  await ADM('POST', '/api/admin/import', { csv: 'NIAT ID,Student Name\nUNIV0003,Geeta Three\n', fileName: 'n.csv', mode: 'merge' });
  assert.equal((await ADM('POST', '/api/admin/import', { csv, fileName: 'u.csv', mode: 'merge' })).status, 200);
  const g = await db.one('SELECT name, university, lms_id FROM students_master WHERE roll_no = ?', 'UNIV0003');
  assert.deepEqual({ ...g }, { name: 'Geeta Three', university: 'Geeta University - Panipat', lms_id: 'uid-3' });
  const im = await ADM('GET', '/api/admin/imports');
  const alard = im.body.universities.find((u) => u.university === 'ALARD - Pune');
  // the 2 rows of this sheet, plus N26P02A… students imported earlier (university from the NIAT ID prefix)
  assert.equal(Number(alard.active), Number((await db.one("SELECT COUNT(*) AS n FROM students_master WHERE university = 'ALARD - Pune' AND active = 1")).n));
  assert.ok(Number(alard.active) >= 2);
  assert.ok(im.body.universities.some((u) => u.university === 'Geeta University - Panipat'));
  // replace with Geeta only: the merged ALARD students go (they have a university); students added one by one stay
  await ADM('POST', '/api/admin/import', { csv: 'NIAT ID,Student Name\nUNIV0009,Added By Hand\n', fileName: 'one.csv', mode: 'merge' });
  // a replace deactivates everyone else in the file-sourced list too; later tests need them, so put them back after
  const wasActive = (await db.all("SELECT roll_no FROM students_master WHERE active = 1 AND roll_no NOT LIKE 'UNIV%'")).map((r) => r.roll_no);
  t.after(async () => { for (const r of wasActive) await db.run('UPDATE students_master SET active = 1 WHERE roll_no = ?', r); });
  const rp = await ADM('POST', '/api/admin/import', { csv: 'University,NIAT ID,Student Name\nGeeta University - Panipat,UNIV0003,Geeta Three\n', fileName: 'g.csv', mode: 'replace' });
  assert.equal(rp.status, 200, JSON.stringify(rp.body));
  const act = async (r) => (await db.one('SELECT active FROM students_master WHERE roll_no = ?', r)).active;
  assert.equal(await act('UNIV0001'), 0);
  assert.equal(await act('UNIV0002'), 0);
  assert.equal(await act('UNIV0003'), 1);
  assert.equal(await act('UNIV0009'), 1, 'a student without a university is not part of a university list');
});

test('archives: "Sprint 1" keeps a frozen copy of students, results and analyses; students list shows and filters universities', async () => {
  // university from the NIAT ID when none is given
  assert.equal((await ADM('POST', '/api/admin/students', { roll_no: 'N26HY03A999', name: 'Prefix Geeta' })).status, 200);
  assert.equal((await db.one('SELECT university FROM students_master WHERE roll_no = ?', 'N26HY03A999')).university, 'Geeta University - Panipat');
  const list = await ADM('GET', '/api/admin/students?university=' + encodeURIComponent('Geeta University - Panipat'));
  assert.ok(list.body.rows.length >= 1 && list.body.rows.every((r) => r.university === 'Geeta University - Panipat'));
  assert.ok(list.body.universities.includes('Geeta University - Panipat'));
  assert.equal((await A('GET', '/api/admin/archives')).status, 401, 'students cannot see archives');
  const mk = await ADM('POST', '/api/admin/archives', { label: 'Sprint 1' });
  assert.equal(mk.status, 200, JSON.stringify(mk.body));
  assert.equal((await ADM('POST', '/api/admin/archives', { label: 'Sprint 1' })).status, 409);
  const ar = (await ADM('GET', '/api/admin/archives')).body.rows.find((a) => a.label === 'Sprint 1');
  const names = ar.files.map((f) => f.name);
  for (const n of ['students.csv', 'feedback.csv', 'business-metrics.json', 'practice-analytics.json']) assert.ok(names.includes(n), n + ' in ' + names);
  assert.ok(names.some((n) => /^results-.+\.csv$/.test(n)), 'results of every Sprint');
  const st = await ADM('GET', '/api/admin/archives/' + ar.id + '/students.csv');
  assert.equal(st.status, 200);
  assert.match(st.text.split('\n')[0], /university/);
  assert.match(st.text, /N26HY03A999,.*Prefix Geeta,Geeta University - Panipat/);
});

test('photo update request: students of the chosen university with an older photo are asked again; others are not', async () => {
  const now = Date.now();
  for (const [r, n] of [['N26P02A0977', 'Alard Photo'], ['N26H01A0977', 'Cdu Photo']]) {
    await db.run("INSERT INTO students_master (roll_no, name, phone, batch, email, active, source, updated_at) VALUES (?, ?, '', '', '', 1, 'file', ?) ON CONFLICT (roll_no) DO NOTHING", r, n, now);
  }
  // listed without a university: the start-up backfill fills it from the NIAT ID
  await db.backfillUniversities();
  assert.equal((await db.one('SELECT university FROM students_master WHERE roll_no = ?', 'N26P02A0977')).university, 'ALARD - Pune');
  const al = client(), cd = client();
  const lg = await al('POST', '/api/auth/name-login', { rollNo: 'n26p02a0977', name: 'PHOTO alard' });
  assert.equal(lg.status, 200, 'any case, any word order: ' + JSON.stringify(lg.body));
  assert.equal((await cd('POST', '/api/auth/name-login', { rollNo: 'N26H01A0977', name: 'Cdu Photo' })).status, 200);
  for (const c of [al, cd]) await c('PUT', '/api/me/photo', { photo: PHOTO });
  assert.equal((await al('GET', '/api/bootstrap')).body.user.photoUpdate, false);
  assert.equal((await A('POST', '/api/admin/photo-update', {})).status, 401);
  assert.equal((await ADM('POST', '/api/admin/photo-update', { university: 'ALARD - Pune' })).status, 200);
  assert.equal((await al('GET', '/api/bootstrap')).body.user.photoUpdate, true, 'Alard students with an older photo are asked');
  assert.equal((await cd('GET', '/api/bootstrap')).body.user.photoUpdate, false, 'other universities are not');
  await new Promise((r) => setTimeout(r, 5));
  await al('PUT', '/api/me/photo', { photo: PHOTO });
  assert.equal((await al('GET', '/api/bootstrap')).body.user.photoUpdate, false, 'asked once: a new photo clears it');
  assert.equal((await ADM('GET', '/api/admin/imports')).body.photoUpdate.university, 'ALARD - Pune');
  await ADM('POST', '/api/admin/photo-update', { cancel: true });
  assert.equal((await ADM('GET', '/api/admin/imports')).body.photoUpdate, null);
  // admins change and download a student's photo; the student's portal gets the new one
  const before = (await al('GET', '/api/bootstrap')).body.user.photoAt;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await A('PUT', '/api/admin/photos/student/N26P02A0977', { photo: PHOTO })).status, 401);
  const ch = await ADM('PUT', '/api/admin/photos/student/N26P02A0977', { photo: PHOTO });
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  assert.ok((await al('GET', '/api/bootstrap')).body.user.photoAt > before);
  assert.equal((await ADM('PUT', '/api/admin/photos/student/NOSUCH01', { photo: PHOTO })).status, 404);
  const dl = await ADM('GET', '/api/admin/photos/student/N26P02A0977?download=1');
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment; filename="N26P02A0977\.jpg"/);
});

test('simple login: a NIAT ID listed without a name accepts any name; the record keeps no name', async () => {
  await db.run("INSERT INTO students_master (roll_no, name, phone, batch, email, active, source, updated_at) VALUES ('N26HY01A953', '', '', '', '', 1, 'file', ?) ON CONFLICT (roll_no) DO NOTHING", Date.now());
  assert.equal((await client()('POST', '/api/auth/name-login', { rollNo: 'N26HY01A953', name: '' })).body.error, 'BAD_NAME', 'a name is still required');
  assert.equal((await client()('POST', '/api/auth/name-login', { rollNo: 'N26HY01A953', name: 'Any Name' })).status, 200);
  assert.equal((await client()('POST', '/api/auth/name-login', { rollNo: 'N26HY01A953', name: 'another one' })).status, 200);
  assert.equal((await db.one('SELECT name FROM students_master WHERE roll_no = ?', 'N26HY01A953')).name, '');
  assert.equal((await client()('POST', '/api/auth/name-login', { rollNo: 'N26HY01A9999', name: 'Any Name' })).body.error, 'BAD_LOGIN', 'unknown IDs still fail');
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
  // off by default; switched on here to test it
  assert.deepEqual((await P('GET', '/api/bootstrap')).body.sprint.proctor, { enabled: false, fullscreen: false, maxViolations: 3, blockCopy: false });
  assert.equal((await ADM('PATCH', '/api/admin/settings', { proctor_enabled: true, proctor_fullscreen: true, proctor_block_copy: true })).status, 200);
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
  await ADM('PATCH', '/api/admin/settings', { proctor_max_violations: 3, proctor_enabled: false, proctor_fullscreen: false, proctor_block_copy: false });
});

test('phones cannot start or continue the Sprint test; tablets and computers can', async () => {
  const now = Date.now();
  for (const r of ['PHTEST01', 'PHTEST02']) {
    await db.run("INSERT INTO students_master (roll_no, name, phone, batch, email, active, source, updated_at) VALUES (?, ?, '', 'A', '', 1, 'admin', ?) ON CONFLICT (roll_no) DO NOTHING", r, 'Ph ' + r, now);
  }
  const IPHONE = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' };
  const PIXEL = { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36' };
  const IPAD = { 'user-agent': 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' };
  const P = client();
  await signup(P, 'PHTEST01', '9222300001');
  let r = await P('POST', '/api/sprint/start', undefined, IPHONE);
  assert.equal(r.status, 403); assert.equal(r.body.error, 'PHONE_BLOCKED');
  assert.equal((await P('POST', '/api/sprint/start', undefined, PIXEL)).body.error, 'PHONE_BLOCKED');
  assert.equal((await P('POST', '/api/sprint/start', undefined, { 'sec-ch-ua-mobile': '?1' })).body.error, 'PHONE_BLOCKED');
  // started on a computer, then opened on a phone: no questions are sent
  r = await P('POST', '/api/sprint/start');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.attempt.questions.length > 0);
  const pb = await P('GET', '/api/bootstrap', undefined, IPHONE);
  assert.equal(pb.body.phoneBlocked, true);
  assert.equal(pb.body.attempt.status, 'running');
  assert.equal(pb.body.attempt.questions, undefined);
  assert.equal((await P('GET', '/api/bootstrap')).body.phoneBlocked, false);
  // tablets are allowed
  const T = client();
  await signup(T, 'PHTEST02', '9222300002');
  assert.equal((await T('POST', '/api/sprint/start', undefined, IPAD)).status, 200);
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
    assert.equal(qs.length, 18, 'the next Sprint has its own 18 questions');
    const count = (k, v) => qs.filter((q) => q[k] === v).length;
    assert.deepEqual([count('level', 'easy'), count('level', 'medium'), count('level', 'hard')], [3, 10, 5], 'mixed difficulty');
    assert.deepEqual([count('course', 'pf'), count('course', 'wad'), count('course', 'genai')], [7, 7, 4]);
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

test('video likes: one per student per topic, counts in bootstrap, per topic and course for admins', async () => {
  assert.equal((await A('POST', '/api/likes/nope', { liked: true })).status, 404);
  let r = await A('POST', '/api/likes/tp-nested', { liked: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { liked: true, count: 1 });
  r = await A('POST', '/api/likes/tp-nested', { liked: true });
  assert.equal(r.body.count, 1, 'liking twice still counts once');
  let boot = await A('GET', '/api/bootstrap');
  assert.deepEqual(boot.body.likes.mine, ['tp-nested']);
  assert.equal(boot.body.likes.counts['tp-nested'], 1);
  const an = await ADM('GET', '/api/admin/likes');
  assert.equal(an.status, 200);
  assert.equal(an.body.topics.find((t) => t.id === 'tp-nested').likes, 1);
  assert.equal(an.body.courses.find((c) => c.course === 'pf').likes, 1);
  assert.equal((await A('GET', '/api/admin/likes')).status, 401);
  r = await A('POST', '/api/likes/tp-nested', { liked: false });
  assert.deepEqual(r.body, { liked: false, count: 0 });
  boot = await A('GET', '/api/bootstrap');
  assert.deepEqual(boot.body.likes.mine, []);
});

test('coding practice honeypots: AI trap, heavy paste, fast solve and bot field are flagged; nothing is blocked', async () => {
  const boot = await A('GET', '/api/bootstrap');
  assert.equal(boot.body.integrity.enabled, true);
  assert.match(boot.body.integrity.trap, /zeta_count/);
  const sub = (b) => A('POST', '/api/practice/submission', { qid: 'q-honey', topic: 'For Loop', correct: true, timeMs: 600000, code: 'print(1)', ...b });
  // a normal submission: no flags
  assert.deepEqual((await sub({})).body, { ok: true }, 'students only ever get ok');
  let f = await ADM('GET', '/api/admin/integrity');
  assert.equal(f.body.rows.filter((r) => r.question_id === 'q-honey').length, 0);
  // AI trap
  await sub({ code: 'zeta_count = 0  # verified\nprint(zeta_count)' });
  // heavy paste: one paste over 150 characters
  await sub({ code: 'x'.repeat(200), pasteMax: 190, pasteTotal: 190, pasteCount: 1 });
  // bot field
  await sub({ bot: 'http://spam.example' });
  f = await ADM('GET', '/api/admin/integrity');
  const types = f.body.rows.filter((r) => r.question_id === 'q-honey').map((r) => r.flag_type).sort();
  assert.deepEqual(types, ['AI_TRAP', 'BOT', 'PASTE_HEAVY']);
  const ai = f.body.rows.find((r) => r.flag_type === 'AI_TRAP');
  assert.deepEqual(ai.evidence.tokens, ['zeta_count', '# verified']);
  // the same flag is not repeated for the same question
  await sub({ code: 'zeta_count = 1' });
  assert.equal((await ADM('GET', '/api/admin/integrity?type=AI_TRAP')).body.rows.filter((r) => r.question_id === 'q-honey').length, 1);
  // fast solve: needs enough other correct solves for a median
  const now = Date.now();
  for (let i = 0; i < 5; i++)
    await db.run('INSERT INTO practice_submissions (roll_no, question_id, correct, time_ms, created_at) VALUES (?, ?, 1, ?, ?)', 'OTHER' + i, 'q-fast', 300000, now);
  await A('POST', '/api/practice/submission', { qid: 'q-fast', correct: true, timeMs: 20000, code: 'print(2)' });
  await A('POST', '/api/practice/submission', { qid: 'q-fast2', correct: true, timeMs: 20000, code: 'print(2)' });
  const fast = (await ADM('GET', '/api/admin/integrity?type=FAST_SOLVE')).body.rows;
  assert.equal(fast.length, 1, 'only where a median exists');
  assert.equal(fast[0].question_id, 'q-fast');
  assert.equal(fast[0].evidence.medianMs, 300000);
  // filters
  assert.equal((await ADM('GET', '/api/admin/integrity?roll=NOBODY1')).body.rows.length, 0);
  assert.equal((await ADM('GET', '/api/admin/integrity?from=' + (now + 864e5))).body.rows.length, 0);
  assert.equal((await A('GET', '/api/admin/integrity')).status, 401);
  // decoy: the code fails the question but solves the decoy problem the clipboard got
  await A('POST', '/api/practice/submission', { qid: 'q-decoy', correct: false, timeMs: 90000, code: 'print(3)', decoyId: 'q-other', decoyPassed: true });
  const dec = (await ADM('GET', '/api/admin/integrity?type=DECOY')).body.rows;
  assert.equal(dec.length, 1);
  assert.equal(dec[0].evidence.decoyId, 'q-other');
  assert.equal((await A('GET', '/api/bootstrap')).body.integrity.copyGuard, 'decoy');
  // admins testing in the portal preview get the traps too; their flags are labelled ADMIN-<id>
  assert.equal((await ADM('GET', '/api/bootstrap')).body.integrity.enabled, true);
  await ADM('POST', '/api/practice/submission', { qid: 'q-admin', correct: true, timeMs: 1000, code: 'zeta_count = 1' });
  const adm = (await ADM('GET', '/api/admin/integrity?type=AI_TRAP')).body.rows.find((r) => r.question_id === 'q-admin');
  assert.match(adm.roll_no, /^ADMIN-\d+$/);
});

test('downloads: uploaded Play/Read HTML downloads as a file with ?download=1', async () => {
  const html = '<!doctype html><html><body><h1>Notes to keep</h1></body></html>';
  assert.equal((await ADM('POST', '/api/admin/media/tp-strings/read/html', { html, fileName: 'n.html' })).status, 200);
  const url = (await A('GET', '/api/bootstrap')).body.unitContent['tp-strings'].read;
  const plain = await fetch(base + url);
  assert.equal(plain.headers.get('content-disposition'), null);
  const dl = await fetch(base + url + '&download=1');
  assert.match(dl.headers.get('content-disposition'), /^attachment; filename="tp-strings-read\.html"$/);
  assert.match(await dl.text(), /Notes to keep/);
  await ADM('DELETE', '/api/admin/media/tp-strings/read');
});

test('feedback: the AI-use answer is stored, summarised for admins and exported', async () => {
  const r = await A('POST', '/api/feedback', { kind: 'sprint-test', rating: 4, text: 'Good sprint, tough questions', aiUse: 'I used AI for some questions' });
  assert.equal(r.status, 200);
  await A('POST', '/api/feedback', { kind: 'portal', rating: 5, text: 'nice portal overall', aiUse: 'made up answer' });
  const fb = await ADM('GET', '/api/admin/feedback');
  assert.equal(fb.body.rows.find((x) => x.text === 'Good sprint, tough questions').ai_use, 'I used AI for some questions');
  assert.equal(fb.body.rows.find((x) => x.text === 'nice portal overall').ai_use, '', 'only the five answers are accepted');
  assert.equal(fb.body.aiSummary.length, 5);
  assert.equal(fb.body.aiSummary.find((a) => a.level === 'I used AI for some questions').count, 1);
  const csv = await (await fetch(base + '/api/admin/export/feedback.csv', { headers: { cookie: ADM.cookie() } })).text();
  assert.match(csv.split('\n')[0], /,ai_use,/);
  assert.match(csv, /I used AI for some questions/);
});

test('practice questions: admins add MCQ and coding by course and topic; the portal gets them after the built-in ones; delete keeps the slot', async () => {
  assert.equal((await A('POST', '/api/admin/practice-questions', { kind: 'mcq' })).status, 401, 'students cannot add questions');
  const bad = await ADM('POST', '/api/admin/practice-questions', { kind: 'mcq', course: 'pf', topic: 'Logical Operators', q: 'Which?', o: ['a', 'a'], c: 0 });
  assert.equal(bad.body.error, 'BAD_OPTIONS');
  const m1 = await ADM('POST', '/api/admin/practice-questions', { kind: 'mcq', course: 'pf', topic: 'Logical Operators', q: 'What is printed?', code: 'print(True and False)', o: ['True', 'False'], c: 1, why: 'and needs both' });
  assert.equal(m1.status, 200, JSON.stringify(m1.body));
  const m2 = await ADM('POST', '/api/admin/practice-questions', { kind: 'mcq', course: 'genai', topic: 'Prompting Basics', q: 'RCAFT: what is T?', o: ['Tone', 'Task'], c: 0 });
  assert.equal(m2.status, 200);
  assert.equal((await ADM('POST', '/api/admin/practice-questions', { kind: 'code', course: 'pf', topic: 'Logical Operators', title: 'Both', text: 'Read two words...', tests: [{ input: '1', output: '2', hidden: true }] })).body.error, 'BAD_TESTS', 'needs a visible sample');
  const c1 = await ADM('POST', '/api/admin/practice-questions', { kind: 'code', course: 'pf', topic: 'Logical Operators', title: 'Both Positive', level: 'easy',
    text: 'Read two integers and print True if both are positive.', tests: [{ input: '1\n2', output: 'True' }, { input: '-1\n2', output: 'False', hidden: true }] });
  assert.equal(c1.status, 200);
  let boot = await A('GET', '/api/bootstrap');
  const px = boot.body.practiceExtra;
  assert.deepEqual(px.mcq.map((q) => q.sess), ['Logical Operators', 'Prompting Basics']);
  assert.equal(px.mcq[0].c, 1);
  assert.equal(px.code[0].id, 'x' + c1.body.id);
  assert.deepEqual(px.code[0].tests, [['1\n2', 'True', false], ['-1\n2', 'False', true]]);
  // delete = archive: the slot stays (answers are stored by position) but it has no course, so Practice hides it
  assert.equal((await ADM('POST', '/api/admin/practice-questions/' + m1.body.id + '/archive', { archived: true })).status, 200);
  boot = await A('GET', '/api/bootstrap');
  assert.equal(boot.body.practiceExtra.mcq.length, 2);
  assert.equal(boot.body.practiceExtra.mcq[0].course, '');
  assert.equal(boot.body.practiceExtra.mcq[1].sess, 'Prompting Basics');
  assert.equal((await ADM('PUT', '/api/admin/practice-questions/' + m2.body.id, { course: 'genai', topic: 'Prompting Basics', q: 'RCAFT: what does T stand for?', o: ['Tone', 'Task', 'Topic'], c: 0 })).status, 200);
  const list = await ADM('GET', '/api/admin/practice-questions');
  assert.equal(list.body.rows.find((r) => r.id === m2.body.id).data.o.length, 3);
  assert.equal(list.body.rows.find((r) => r.id === m1.body.id).archived, true);
  // practice analytics knows them (gi after the built-in ones)
  const pa = await ADM('GET', '/api/admin/practice?fresh=1');
  assert.equal(pa.status, 200);
  assert.ok(JSON.stringify(pa.body).includes('RCAFT: what does T stand for?'), 'practice analytics lists the admin-added MCQ');
});

test('practice JSON import: stems come in as drafts, complete questions go live, re-import updates, finishing a draft publishes it', async () => {
  // the content format as exported today: question text only
  const stems = { track: 'Programming Foundations', course: 'Computer Programming', session: 'Logical Operators',
    mcq_practice: [{ set_id: 's1', questions: [
      { question_id: 'qa1', question_type: 'CODE_ANALYSIS_MULTIPLE_CHOICE', question_content: 'What will be the output of the given Python code?<br><br>' },
      { question_id: 'qa2', question_type: 'CODE_ANALYSIS_TEXTUAL', question_content: 'Write the output' }] }],
    coding_practice: [{ set_id: 'c1', questions: [{ question_id: 'qc1', question_type: 'CODING', question_short_text: 'Even or Odd', question_difficulty: 'EASY',
      question_content: 'Read N and print Even or Odd.\r\n\r\n---\r\n\r\n#### Input\r\n\r\nAn integer.' }] }] };
  // the same format with options, answers, code and test cases filled in
  const full = { track: 'GenAI', course: 'Introduction to Generative AI', session: 'Prompting — Part - 2',
    mcq_practice: [{ questions: [
      { question_id: 'qb1', question_type: 'MULTIPLE_CHOICE', question_content: 'In RCAFT, what does <b>T</b> stand for?',
        options: [{ option_id: 'o1', content: 'Task' }, { option_id: 'o2', content: 'Tone' }], correct_answer: [{ option_id: 'o2' }], explanation: 'Tone is the style.' },
      { question_id: 'qb2', question_type: 'CODE_ANALYSIS_MULTIPLE_CHOICE', question_content: 'Output?\n```python\nprint(2 + 3)\n```', options: ['5', '23'], correct_answer: '5' }] }],
    coding_practice: [] };
  const fullPf = { track: 'Programming Foundations', session: 'Logical Operators', mcq_practice: [], coding_practice: [{ questions: [
    { question_id: 'qc2', question_type: 'CODING', question_short_text: 'Both Positive', question_difficulty: 'MEDIUM', question_content: 'Read two numbers...',
      test_cases: [{ input: '1\n2', output: 'True', is_hidden: false }, { input: '-1\n2', output: 'False', is_hidden: true }] }] }] };
  const files = [{ name: 'stems.json', json: JSON.stringify(stems) }, { name: 'full.json', json: JSON.stringify(full) }, { name: 'pf.json', json: JSON.stringify(fullPf) }, { name: 'bad.json', json: '{oops' }];

  const pre = await ADM('POST', '/api/admin/practice-questions/import', { files, dry: true });
  assert.equal(pre.status, 200, JSON.stringify(pre.body));
  assert.deepEqual(pre.body.summary, { total: 6, ready: 3, drafts: 2, skipped: 1, add: 5, update: 0 });
  assert.equal(pre.body.problems[0].file, 'bad.json');
  const why = (id) => pre.body.items.find((i) => i.title.startsWith(id));
  assert.match(why('What will be the output').why, /no options/);
  assert.match(why('What will be the output').why, /code snippet missing/);
  assert.match(why('Even or Odd').why, /no test cases/);
  assert.equal(pre.body.items.find((i) => i.type === 'CODE_ANALYSIS_TEXTUAL').status, 'skipped');
  assert.equal(pre.body.items.find((i) => i.course === 'genai').topic, 'Prompting | Part 2', 'no em dashes; "Part - 2" tidied');
  assert.equal((await ADM('GET', '/api/admin/practice-questions')).body.rows.filter((r) => r.srcId).length, 0, 'preview writes nothing');

  const imp = await ADM('POST', '/api/admin/practice-questions/import', { files, dry: false });
  assert.equal(imp.body.imported, true);
  let list = (await ADM('GET', '/api/admin/practice-questions')).body.rows.filter((r) => r.srcId);
  assert.equal(list.length, 5);
  assert.deepEqual(list.filter((r) => r.draft).map((r) => r.srcId).sort(), ['qa1', 'qc1']);
  const b1 = list.find((r) => r.srcId === 'qb1');
  assert.deepEqual([b1.data.q, b1.data.o, b1.data.c, b1.data.why], ['In RCAFT, what does T stand for?', ['Task', 'Tone'], 1, 'Tone is the style.']);
  assert.equal(list.find((r) => r.srcId === 'qb2').data.code, 'print(2 + 3)');
  let boot = await A('GET', '/api/bootstrap');
  assert.ok(boot.body.practiceExtra.mcq.some((q) => q.q === 'In RCAFT, what does T stand for?' && q.sess === 'Prompting | Part 2'));
  assert.ok(!boot.body.practiceExtra.mcq.some((q) => /What will be the output/.test(q.q)), 'drafts stay hidden');
  assert.ok(boot.body.practiceExtra.code.some((c) => c.title === 'Both Positive' && c.tests.length === 2));
  assert.ok(!boot.body.practiceExtra.code.some((c) => c.title === 'Even or Odd'));

  // importing again updates by question_id
  const again = await ADM('POST', '/api/admin/practice-questions/import', { files: [files[1]], dry: false });
  assert.equal(again.body.summary.update, 2);
  assert.equal((await ADM('GET', '/api/admin/practice-questions')).body.rows.filter((r) => r.srcId).length, 5);

  // delete many at once; importing again brings them back
  const drafts = (await ADM('GET', '/api/admin/practice-questions')).body.rows.filter((r) => r.draft && !r.archived);
  assert.equal((await ADM('POST', '/api/admin/practice-questions/archive-many', { ids: drafts.map((r) => r.id), archived: true })).body.count, drafts.length);
  assert.equal((await ADM('GET', '/api/admin/practice-questions')).body.rows.filter((r) => r.draft && !r.archived).length, 0);
  await ADM('POST', '/api/admin/practice-questions/import', { files: [files[0]], dry: false });
  assert.equal((await ADM('GET', '/api/admin/practice-questions')).body.rows.filter((r) => r.draft && !r.archived).length, drafts.length);

  // finishing a draft in the editor publishes it
  const d1 = list.find((r) => r.srcId === 'qa1');
  assert.equal((await ADM('PUT', '/api/admin/practice-questions/' + d1.id, { course: 'pf', topic: 'Logical Operators', q: 'What will be the output?', code: 'print(not True)', o: ['True', 'False'], c: 1 })).status, 200);
  list = (await ADM('GET', '/api/admin/practice-questions')).body.rows;
  assert.equal(list.find((r) => r.id === d1.id).draft, false);
  boot = await A('GET', '/api/bootstrap');
  assert.ok(boot.body.practiceExtra.mcq.some((q) => q.code === 'print(not True)'));
});

test('admin data survives content changes: removed topics keep steps, time and likes; deleted questions keep their answers', async () => {
  // a student finished Watch on For Loop (by position and by id) and on a topic that no longer exists
  const prog = (await A('GET', '/api/bootstrap')).body.progress || {};
  const pfIdx = (await A('GET', '/api/bootstrap')).body.units.units.filter((u) => u.course === 'pf').findIndex((u) => u.id === 'tp-forloop');
  const data = { ...prog, stepDone: { ...(prog.stepDone || {}), ['pf-' + pfIdx + '-0:watch']: true }, stepDoneById: { ...(prog.stepDoneById || {}), 'tp-forloop:watch': true, 'u-gone-topic:read': true } };
  assert.equal((await A('PUT', '/api/progress', { data })).status, 200);
  await A('POST', '/api/likes/tp-forloop', { liked: true });

  // a super admin removes the For Loop topic from the portal
  assert.equal((await ADM('DELETE', '/api/admin/content/builtin/units/tp-forloop')).status, 200);
  const det = await ADM('GET', '/api/admin/analytics/students/NIAT24001');
  assert.equal(det.status, 200, JSON.stringify(det.body));
  const fl = det.body.units.find((u) => u.id === 'tp-forloop');
  assert.ok(fl, 'the removed topic is still listed for the student');
  assert.equal(fl.removed, true);
  assert.equal(fl.steps.watch.done, true, 'its finished step is still shown');
  const likes = (await ADM('GET', '/api/admin/likes')).body.topics.find((u) => u.id === 'tp-forloop');
  assert.equal(likes.likes, 1, 'its likes are still counted');
  assert.equal(likes.removed, true);
  const ov = await ADM('GET', '/api/admin/analytics/overview');
  if (ov.status === 200 && ov.body.units) assert.ok(ov.body.units.some((u) => u.id === 'tp-forloop'));
  assert.equal((await ADM('POST', '/api/admin/content/builtin/units/tp-forloop/restore')).status, 200);
  await A('POST', '/api/likes/tp-forloop', { liked: false });

  // an added topic that is deleted keeps its name in the analytics, and its id is never reused
  await ADM('POST', '/api/admin/content/units', { course: 'pf', title: 'Temporary Topic' });
  await A('POST', '/api/likes/u-temporary-topic', { liked: true });
  assert.equal((await ADM('DELETE', '/api/admin/content/units/u-temporary-topic')).status, 200);
  const gone = (await ADM('GET', '/api/admin/likes')).body.topics.find((u) => u.id === 'u-temporary-topic');
  assert.deepEqual([gone.title, gone.likes, gone.removed], ['Temporary Topic', 1, true]);
  assert.equal((await ADM('POST', '/api/admin/content/units', { course: 'pf', title: 'Temporary Topic' })).body.id, 'u-temporary-topic-2');
  await ADM('DELETE', '/api/admin/content/units/u-temporary-topic-2');

  // a deleted practice question keeps the students' answers in Practice analytics
  const q = await ADM('POST', '/api/admin/practice-questions', { kind: 'mcq', course: 'pf', topic: 'Keep Data', q: 'Kept question?', o: ['Yes', 'No'], c: 0 });
  const boot = await A('GET', '/api/bootstrap');
  const builtTotal = JSON.parse(fs.readFileSync(path.join(here, '..', 'generated', 'practice.json'), 'utf8')).total;
  const gi = builtTotal + boot.body.practiceExtra.mcq.findIndex((x) => x.xid === q.body.id);
  const p2 = (await A('GET', '/api/bootstrap')).body.progress || {};
  await A('PUT', '/api/progress', { data: { ...p2, pPick: { ...(p2.pPick || {}), [gi]: 0 } } });
  // a save without the by-id record (an old page) does not erase it
  await A('PUT', '/api/progress', { data: { ...p2, stepDoneById: undefined, pPick: { ...(p2.pPick || {}), [gi]: 0 } } });
  assert.equal((await db.one('SELECT data FROM progress WHERE roll_no = ?', 'NIAT24001')).data.includes('u-gone-topic:read'), true);
  await ADM('POST', '/api/admin/practice-questions/' + q.body.id + '/archive', { archived: true });
  const pa = (await ADM('GET', '/api/admin/practice?fresh=1')).body;
  const kq = pa.quiz.find((x) => x.q === 'Kept question?');
  assert.ok(kq, 'deleted question still in Practice analytics');
  assert.equal(kq.removed, true);
  assert.ok(kq.attempted >= 1 && kq.correct >= 1, 'with the answers');
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

test('practice questions used in a Sprint test are hidden from Practice (no repeats), marked for admins', async () => {
  const set = JSON.parse(fs.readFileSync(path.join(here, '..', 'generated', 'sprint-sets', 'sprint-2026-10-10.json'), 'utf8'));
  const used = set.find((q) => q.src);
  assert.ok(used, 'the set names its Practice questions');
  const file = { track: 'Programming Foundations', session: 'Repeat Check', mcq_practice: [{ questions: [
    { question_id: used.src, question_type: 'MULTIPLE_CHOICE', question_content: 'Used in the test?', options: ['Yes', 'No'], correct_answer: 'Yes' },
    { question_id: 'not-in-any-set', question_type: 'MULTIPLE_CHOICE', question_content: 'Free to practise?', options: ['Yes', 'No'], correct_answer: 'Yes' }] }], coding_practice: [] };
  const imp = await ADM('POST', '/api/admin/practice-questions/import', { files: [{ name: 'r.json', json: JSON.stringify(file) }], dry: false });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  const rows = (await ADM('GET', '/api/admin/practice-questions')).body.rows;
  assert.equal(rows.find((r) => r.srcId === used.src).inSprint, true);
  assert.equal(rows.find((r) => r.srcId === 'not-in-any-set').inSprint, false);
  await new Promise((r) => setTimeout(r, 11000)); // the portal list is cached for 10 s per instance
  const mcq = (await A('GET', '/api/bootstrap')).body.practiceExtra.mcq;
  assert.ok(!mcq.some((q) => q.q === 'Used in the test?'), 'hidden from students');
  assert.ok(mcq.some((q) => q.q === 'Free to practise?' && q.sess === 'Repeat Check'));
});

test('test order: each student gets their own fixed shuffle of questions and options; boards per university with photos; photo ZIPs', async () => {
  const sp = await import('../sprint.js');
  const qs = await sp.getQuestions();
  const a1 = { sprint_id: 's', roll_no: 'R1', started_at: 1 }, a2 = { sprint_id: 's', roll_no: 'R2', started_at: 1 };
  const o1 = sp.attemptOrder(a1, qs), o2 = sp.attemptOrder(a2, qs);
  const isPerm = (p, n) => p.length === n && [...p].sort((x, y) => x - y).every((v, i) => v === i);
  assert.ok(isPerm(o1.order, qs.length));
  qs.forEach((q, i) => { if (q.type === 'mcq') assert.ok(isPerm(o1.optOrder[i], q.o.length)); });
  assert.deepEqual(sp.attemptOrder(a1, qs), o1, 'same student, same order (a reload shows the same test)');
  assert.notDeepEqual(o1.order, o2.order, 'another student, another order');

  // two universities, one board each; photos as opaque links
  const now = Date.now(), sid = 'board-uni-test';
  for (const [r, n, u, t] of [['N26P02A0991', 'Alard Top', 'ALARD - Pune', 9], ['N26P02A0992', 'Alard Two', 'ALARD - Pune', 5], ['N26HY03A991', 'Geeta Top', 'Geeta University - Panipat', 7]]) {
    await db.run("INSERT INTO students_master (roll_no, name, phone, batch, email, university, active, source, updated_at) VALUES (?, ?, '', '', '', ?, 1, 'file', ?) ON CONFLICT (roll_no) DO NOTHING", r, n, u, now);
    await db.run("INSERT INTO attempts (sprint_id, roll_no, status, started_at, deadline_at, submitted_at, total, max_total, used_ms, updated_at) VALUES (?, ?, 'submitted', ?, ?, ?, ?, 18, 60000, ?)", sid, r, now, now + 1, now, t, now);
  }
  const ga = client();
  assert.equal((await ga('POST', '/api/auth/name-login', { rollNo: 'N26HY03A991', name: 'geeta top' })).status, 200);
  await ga('PUT', '/api/me/photo', { photo: PHOTO });
  const lb = (await ga('GET', '/api/leaderboard?sprint=' + sid)).body;
  assert.equal(lb.sprintId, sid);
  assert.equal(lb.university, 'Geeta University - Panipat');
  assert.deepEqual(lb.rows.map((r) => r.name), ['Geeta Top'], 'Geeta students see Geeta only');
  assert.equal(lb.me.rank, 1);
  assert.ok(lb.rows[0].photo && !lb.rows[0].photo.includes('N26HY03A991'), 'photo link does not show the NIAT ID');
  assert.equal((await ga('GET', lb.rows[0].photo)).status, 200);
  assert.equal((await client()('GET', lb.rows[0].photo)).status, 401, 'logged-in users only');
  assert.ok(lb.sprints.some((s) => s.id === sid));
  const adm = (await ADM('GET', '/api/admin/leaderboard?sprint=' + sid + '&university=' + encodeURIComponent('ALARD - Pune'))).body;
  assert.deepEqual(adm.rows.map((r) => [r.name, Number(r.rank)]), [['Alard Top', 1], ['Alard Two', 2]]);
  assert.equal((await ADM('GET', '/api/admin/leaderboard?sprint=' + sid)).body.rows.length, 3, 'admins: all universities');

  // photos as a ZIP
  const parts = (await ADM('GET', '/api/admin/photos/parts?university=' + encodeURIComponent('Geeta University - Panipat'))).body.parts;
  assert.ok(parts.length >= 1);
  const zr = await fetch(base + '/api/admin/photos/zip?university=' + encodeURIComponent('Geeta University - Panipat') + '&first=' + parts[0].first + '&last=' + parts[0].last, { headers: { cookie: ADM.cookie() } });
  assert.equal(zr.status, 200);
  const buf = Buffer.from(await zr.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'a ZIP file');
  assert.ok(buf.includes(Buffer.from('N26HY03A991.jpg')));
});

test('analytics per Sprint: Sprint 1 = before Fri 9 Oct 2026 IST, Sprint 2 = from then; every page takes the filter', async () => {
  const { SPRINT2_START } = await import('../periods.js');
  const now = Date.now();
  // an old student (listed before Sprint 2) active on 5 Oct and on 9 Oct; a new student added for Sprint 2
  await db.run("INSERT INTO students_master (roll_no, name, phone, batch, email, active, source, updated_at) VALUES ('PERIOD01', 'Old Student', '', '', '', 1, 'file', ?) ON CONFLICT (roll_no) DO NOTHING", now);
  await db.run("INSERT INTO students_master (roll_no, name, phone, batch, email, active, source, updated_at, created_at) VALUES ('PERIOD02', 'New Student', '', '', '', 1, 'file', ?, ?) ON CONFLICT (roll_no) DO NOTHING", now, SPRINT2_START + 1000);
  for (const [day, ms] of [['2026-10-05', 600000], ['2026-10-09', 300000]]) {
    await db.run("INSERT INTO activity (roll_no, day, area, item, step, ms, opens, video_ms, video_pct, updated_at) VALUES ('PERIOD01', ?, 'practice', 'x', '', ?, 1, 0, 0, ?) ON CONFLICT DO NOTHING", day, ms, now);
  }
  const rows = async (p) => (await ADM('GET', '/api/admin/analytics/students?days=365&q=PERIOD0&period=' + p)).body;
  const s1 = await rows('s1'), s2 = await rows('s2');
  assert.equal(s1.period.id, 's1');
  assert.deepEqual(s1.rows.map((r) => r.roll_no), ['PERIOD01'], 'Sprint 1: only students listed before 9 Oct');
  assert.equal(s1.rows[0].practice_ms, 600000, 'Sprint 1: activity before 9 Oct');
  assert.equal(s2.rows.find((r) => r.roll_no === 'PERIOD01').practice_ms, 300000, 'Sprint 2: activity from 9 Oct');
  assert.ok(s2.rows.some((r) => r.roll_no === 'PERIOD02'));
  for (const url of ['/api/admin/analytics/overview?days=30', '/api/admin/analytics/business?fresh=1', '/api/admin/practice?fresh=1', '/api/admin/likes?v=1', '/api/admin/integrity?type=', '/api/admin/feedback?v=1']) {
    for (const p of ['s1', 's2']) {
      const r = await ADM('GET', url + '&period=' + p);
      assert.equal(r.status, 200, url + ' ' + p + ' ' + JSON.stringify(r.body).slice(0, 200));
    }
  }
  const o1 = (await ADM('GET', '/api/admin/analytics/overview?days=30&period=s1')).body, o2 = (await ADM('GET', '/api/admin/analytics/overview?days=30&period=s2')).body;
  assert.ok(o1.units.every((u) => !u.id.startsWith('u-')) && o2.units.every((u) => u.id.startsWith('u-')), 'built-in topics are Sprint 1, added topics Sprint 2');
  assert.equal((await ADM('GET', '/api/admin/analytics/business?fresh=1&period=s1')).body.period.id, 's1');
});
