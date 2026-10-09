// Load simulator: N virtual students run the real Sprint journey against a deployment.
//
//   1. Make test students:   node loadtest/simulate.js make-csv 15000 > loadtest-students.csv
//      and import them on the STAGING deployment (Admin → Master data, or npm run import-students).
//   2. Open the Sprint window on staging. Then pick the log-in the site uses:
//        --login name (default)  NIAT ID + name, the "simple" log-in mode. Nothing else to set up.
//        --login otp             register with OTP + password + photo. Needs ALLOW_TEST_OTP=true on staging (codes come
//                                back in the API response; never on production) and "Auto-approve registrations" ticked
//                                (Admin → Sprint settings). Untick it afterwards.
//   3. Run:  node loadtest/simulate.js run --url https://staging.example.com --students 2000 --ramp 60
//      One machine can drive ~2,000–4,000 students; run it from several machines for 15,000.
//      Name log-in allows 3,000 log-ins per network per 15 min, and all students from one machine share its address.
//      --spread-ips gives each student its own X-Forwarded-For address; it only has an effect where the server trusts
//      that header (a local test server started with TRUST_PROXY=1). Behind Vercel the header is set by Vercel.
//
// Journey per student: log in → bootstrap → start Sprint → autosave every 15 s × N → submit
// (spread over 20 s like the real portal) → poll leaderboard every 30 s.
// Never run this against production: it creates accounts and Sprint attempts for the LT… students.
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };

if (cmd === 'make-csv') {
  const n = Number(args[1] || 1000);
  const lines = ['roll_no,name,phone,batch'];
  for (let i = 1; i <= n; i++) lines.push(`LT${String(i).padStart(5, '0')},Load Test ${i},+9190${String(i).padStart(8, '0')},LOADTEST`);
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
}
if (cmd !== 'run') {
  console.log('Usage:\n  node loadtest/simulate.js make-csv 15000 > loadtest-students.csv\n  node loadtest/simulate.js run --url http://localhost:3000 --students 300 --ramp 30 [--login name|otp] [--saves 4] [--offset 0] [--spread-ips]');
  process.exit(1);
}

const BASE = opt('url', 'http://localhost:3000').replace(/\/$/, '');
const N = Number(opt('students', 100)), RAMP = Number(opt('ramp', 30)) * 1000, SAVES = Number(opt('saves', 4));
const OFFSET = Number(opt('offset', 0)), SAVE_MS = Number(opt('save-ms', 15000)), POLLS = Number(opt('polls', 2));
const LOGIN = opt('login', 'name'), SPREAD_IPS = args.includes('--spread-ips');
// Registration needs a password and a photograph (a tiny JPEG stands in for the photo).
const PASSWORD = 'LoadTest2026', PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP==';
const stats = new Map(), errors = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(name, method, path, body, jar) {
  const t = performance.now();
  let status = 0, json = null;
  try {
    const res = await fetch(BASE + path, {
      method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(jar.c ? { cookie: jar.c } : {}), ...(jar.ip ? { 'x-forwarded-for': jar.ip } : {}), origin: BASE },
      body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000)
    });
    status = res.status;
    const set = res.headers.getSetCookie();
    if (set.length) jar.c = set.map((c) => c.split(';')[0]).join('; ');
    json = await res.json().catch(() => null);
  } catch (e) { status = e.name === 'TimeoutError' ? 'timeout' : 'network'; }
  const ms = performance.now() - t;
  if (!stats.has(name)) stats.set(name, []);
  stats.get(name).push(ms);
  const ok = typeof status === 'number' && status < 400;
  if (!ok) { const k = name + ' ' + status + (json && json.error ? ' ' + json.error : ''); errors.set(k, (errors.get(k) || 0) + 1); }
  return { ok, status, json };
}

let finished = 0, submitted = 0;
async function student(i) {
  const n = i + OFFSET + 1, roll = `LT${String(n).padStart(5, '0')}`, phone = '90' + String(n).padStart(8, '0'), jar = {};
  if (SPREAD_IPS) jar.ip = `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
  if (LOGIN === 'name') {
    if (!(await call('name-login', 'POST', '/api/auth/name-login', { rollNo: roll, name: 'Load Test ' + n }, jar)).ok) return;
  } else {
    let s = await call('otp/start', 'POST', '/api/auth/register/start', { rollNo: roll, phone }, jar);
    let purpose = 'register';
    if (s.json && s.json.error === 'ALREADY_REGISTERED') { s = await call('otp/start', 'POST', '/api/auth/login/start', { rollNo: roll }, jar); purpose = 'login'; }
    if (!s.ok || !s.json.devOtp) return;
    const body = purpose === 'register' ? { rollNo: roll, otp: s.json.devOtp, phone, password: PASSWORD, photo: PHOTO } : { rollNo: roll, otp: s.json.devOtp };
    const v = await call('otp/verify', 'POST', `/api/auth/${purpose}/verify`, body, jar);
    if (!v.ok) return;
    if (v.json && v.json.status === 'pending') {
      const k = 'registration pending: tick "Auto-approve registrations" in Admin → Sprint settings for the load test';
      errors.set(k, (errors.get(k) || 0) + 1);
      return;
    }
  }
  const b = await call('bootstrap', 'GET', '/api/bootstrap', undefined, jar);
  if (!b.ok) return;
  const st = await call('sprint/start', 'POST', '/api/sprint/start', undefined, jar);
  const qs = st.ok && st.json.attempt.questions;
  if (qs) {
    const answers = { mcq: {}, text: {}, code: {} };
    for (let k = 0; k < SAVES; k++) {
      await sleep(SAVE_MS * (0.8 + Math.random() * 0.4));
      qs.forEach((q, qi) => { if (q.type === 'mcq' && Math.random() < 0.5) answers.mcq[qi] = Math.floor(Math.random() * q.o.length); });
      await call('sprint/draft', 'PUT', '/api/sprint/draft', answers, jar);
    }
    const ci = qs.findIndex((q) => q.type === 'code');
    if (ci >= 0) answers.code[ci] = 'n = int(input())\nprint(sum(i for i in range(2, n + 1, 2)))';
    qs.forEach((q, qi) => { if (q.type === 'text') answers.text[qi] = 'Load test answer ' + roll; });
    await sleep(Math.random() * 20000);
    if ((await call('sprint/submit', 'POST', '/api/sprint/submit', answers, jar)).ok) submitted++;
  }
  for (let k = 0; k < POLLS; k++) { await call('leaderboard', 'GET', '/api/leaderboard?limit=100', undefined, jar); await sleep(30000 * (0.8 + Math.random() * 0.4)); }
}

const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p / 100 * a.length))] : 0; };
function report(final) {
  console.log(`\n${final ? 'FINAL' : 'progress'} · ${finished}/${N} students done · ${submitted} submitted`);
  console.log('endpoint            count     p50      p95      p99      max');
  for (const [k, v] of stats) console.log(k.padEnd(18), String(v.length).padStart(6), ...[50, 95, 99].map((p) => (pct(v, p).toFixed(0) + 'ms').padStart(8)), (Math.max(...v).toFixed(0) + 'ms').padStart(8));
  if (errors.size) { console.log('errors:'); for (const [k, n] of errors) console.log('  ' + k + ': ' + n); } else console.log('errors: none');
}

console.log(`Simulating ${N} students against ${BASE} (${LOGIN} log-in, ramp ${RAMP / 1000}s, ${SAVES} autosaves each${SPREAD_IPS ? ', one address each' : ''})…`);
const t0 = Date.now();
const timer = setInterval(() => report(false), 15000);
await Promise.all(Array.from({ length: N }, (_, i) => sleep((i / N) * RAMP).then(() => student(i)).catch(() => {}).finally(() => finished++)));
clearInterval(timer);
report(true);
console.log(`total time ${((Date.now() - t0) / 1000).toFixed(0)}s`);
