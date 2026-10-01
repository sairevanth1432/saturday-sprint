// Creates test accounts in the LOCAL database for trying the portal on localhost.
//   npm run seed-test                 admins + test students, and opens a separate test Sprint for 24 h
//   npm run seed-test -- --no-sprint  same, but leave the Sprint settings alone
// Refuses to run against production. Test students use NIAT IDs TEST0001… and batch "TEST", so they
// never mix with real students; a later master-sheet import does not remove them.
import { config } from '../config.js';
import { ready, one, run, close, setSetting } from '../db.js';
import { hashPassword } from '../security.js';

if (config.isProd || config.isVercel || (config.databaseUrl && !process.argv.includes('--allow-remote-db'))) {
  console.error('Refusing: seed-test is for the local database only (NODE_ENV=production or DATABASE_URL is set).');
  process.exit(1);
}

// Approved test students log in with this password (or with a code via "Log in with a code").
const STUDENT_PASSWORD = 'Sprint2026';

const ADMINS = [
  { email: 'admin@test.local', name: 'Test Super Admin', role: 'super_admin', password: 'SprintAdmin#2026' },
  { email: 'staff@test.local', name: 'Test Admin', role: 'admin', password: 'SprintStaff#2026' }
];
const STUDENTS = [
  { roll: 'TEST0001', name: 'Test Student One', phone: '+919000000001', state: 'approved' },
  { roll: 'TEST0002', name: 'Test Student Two', phone: '+919000000002', state: 'approved' },
  { roll: 'TEST0003', name: 'Test Student Three', phone: '+919000000003', state: 'approved' },
  { roll: 'TEST0004', name: 'Test Pending Student', phone: '+919000000004', state: 'pending' },
  { roll: 'TEST0005', name: 'Test New Student', phone: '+919000000005', state: 'new' }
];

await ready();
const now = Date.now();

for (const a of ADMINS) {
  const ex = await one('SELECT id FROM admins WHERE email = ?', a.email);
  if (ex) await run('UPDATE admins SET name = ?, role = ?, password_hash = ?, must_change_pw = 0, status = ?, failed_logins = 0, locked_until = 0 WHERE id = ?',
    a.name, a.role, hashPassword(a.password), 'active', ex.id);
  else await run('INSERT INTO admins (email, name, role, password_hash, must_change_pw, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    a.email, a.name, a.role, hashPassword(a.password), now);
}

for (const s of STUDENTS) {
  await run(`INSERT INTO students_master (roll_no, name, phone, batch, email, active, source, updated_at) VALUES (?, ?, ?, 'TEST', ?, 1, 'admin', ?)
             ON CONFLICT (roll_no) DO UPDATE SET name = excluded.name, phone = excluded.phone, batch = 'TEST', active = 1, source = 'admin', updated_at = excluded.updated_at`,
    s.roll, s.name, s.phone, s.roll.toLowerCase() + '@test.local', now);
  // reset to the intended state
  await run("DELETE FROM sessions WHERE kind = 'student' AND subject_id IN (SELECT id FROM users WHERE roll_no = ?)", s.roll);
  await run('DELETE FROM users WHERE roll_no = ?', s.roll);
  await run('DELETE FROM registration_requests WHERE roll_no = ?', s.roll);
  if (s.state === 'approved') {
    await run('INSERT INTO users (roll_no, phone, status, created_at, password_hash, password_set_at) VALUES (?, ?, ?, ?, ?, ?)', s.roll, s.phone, 'active', now, hashPassword(STUDENT_PASSWORD), now);
    await run("INSERT INTO registration_requests (roll_no, phone, status, created_at, decided_at, decided_by) VALUES (?, ?, 'approved', ?, ?, 'seed-test')", s.roll, s.phone, now, now);
  } else if (s.state === 'pending') {
    await run("INSERT INTO registration_requests (roll_no, phone, status, created_at) VALUES (?, ?, 'pending', ?)", s.roll, s.phone, now);
  }
}

if (!process.argv.includes('--no-sprint')) {
  // A separate Sprint id keeps test attempts away from the real Sprint's results.
  await setSetting('sprint_id', 'local-test');
  await setSetting('sprint_title', 'Local test Sprint');
  await setSetting('sprint_open', new Date(now - 5 * 60000).toISOString());
  await setSetting('sprint_close', new Date(now + 24 * 3600000).toISOString());
  await run("DELETE FROM attempts WHERE sprint_id = 'local-test' AND roll_no LIKE 'TEST%'");
}
await close();

const line = (a, b, c) => console.log('  ' + a.padEnd(22) + b.padEnd(22) + c);
console.log('\nTest accounts ready (local database only). Start the site with: npm start → http://localhost:3000\n');
console.log('ADMIN  (http://localhost:3000/admin)');
line('Email', 'Password', 'Role');
for (const a of ADMINS) line(a.email, a.password, a.role === 'super_admin' ? 'super admin (everything)' : 'admin (no imports/settings/admins)');
console.log('\nSTUDENTS  (http://localhost:3000/login; approved accounts use the password ' + STUDENT_PASSWORD + '; codes are shown on screen locally)');
line('NIAT ID', 'Phone', 'State');
for (const s of STUDENTS) line(s.roll, s.phone.replace('+91', ''), {
  approved: 'approved → Log in', pending: 'waiting → approve it in Admin → Approvals', new: 'not registered → use Register'
}[s.state]);
console.log(process.argv.includes('--no-sprint') ? '\nSprint settings unchanged.' :
  '\nA test Sprint ("local-test") is open for the next 24 hours. Change it in Admin → Sprint settings.');
console.log('Run this again any time to reset the test accounts.\n');
