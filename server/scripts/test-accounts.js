// Test students for the PRODUCTION portal (or any deployment). OTPs are real SMS, so use phones your testers hold.
//
//   node scripts/test-accounts.js add --phones 9876543210,9123456789      → TEST0001, TEST0002 (approved, batch TEST)
//   … add --phones 98…,91… --password Sprint2026                         → also sets a login password
//   node scripts/test-accounts.js universities                            → TEST-N26P02A (ALARD) … one per university,
//                                                                           log in with NIAT ID + name; --password also sets one
//   node scripts/test-accounts.js list
//   node scripts/test-accounts.js remove                                  → deletes all TEST* accounts, attempts, progress
//
// On the Docker server:  docker compose exec app node scripts/test-accounts.js add --phones 98…,91…
// Test students (batch TEST) never appear on the production leaderboard. Remove them before the real Sprint.
import { ready, one, all, run, tx, close, audit } from '../db.js';
import { normPhone, hashPassword } from '../security.js';
import { TEST_UNIVERSITY_STUDENTS } from '../universities.js';

const [cmd] = process.argv.slice(2);
const arg = (n) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : undefined; };
await ready();
const now = Date.now();
// Optional --password: testers log in with NIAT ID + password; without it they use "Log in with a code" (or ID + name).
const password = arg('password') ? String(arg('password')) : '';
if (password && (password.length < 8 || !/[a-z]/i.test(password) || !/[0-9]/.test(password))) { console.error('Password: at least 8 characters with letters and a number.'); process.exit(1); }

if (cmd === 'add') {
  const phones = String(arg('phones') || '').split(',').map((p) => p.trim()).filter(Boolean);
  if (!phones.length) { console.error('Usage: node scripts/test-accounts.js add --phones 9876543210,9123456789'); process.exit(1); }
  const bad = phones.filter((p) => !normPhone(p));
  if (bad.length) { console.error('Invalid phone number(s): ' + bad.join(', ')); process.exit(1); }
  const made = [];
  await tx(async () => {
    for (const [i, raw] of phones.entries()) {
      const phone = normPhone(raw), roll = 'TEST' + String(i + 1).padStart(4, '0');
      const other = await one('SELECT roll_no FROM users WHERE phone = ? AND roll_no <> ?', phone, roll);
      if (other) throw new Error(`Phone ${raw} already belongs to the account of ${other}.`);
      await run(`INSERT INTO students_master (roll_no, name, phone, batch, email, active, source, updated_at) VALUES (?, ?, ?, 'TEST', '', 1, 'admin', ?)
                 ON CONFLICT (roll_no) DO UPDATE SET name = excluded.name, phone = excluded.phone, batch = 'TEST', active = 1, source = 'admin', updated_at = excluded.updated_at`,
        roll, 'Test Student ' + (i + 1), phone, now);
      await run("DELETE FROM sessions WHERE kind = 'student' AND subject_id IN (SELECT id FROM users WHERE roll_no = ?)", roll);
      await run('DELETE FROM users WHERE roll_no = ?', roll);
      await run('INSERT INTO users (roll_no, phone, status, created_at, password_hash, password_set_at) VALUES (?, ?, ?, ?, ?, ?)', roll, phone, 'active', now, password ? hashPassword(password) : null, password ? now : null);
      await run("INSERT INTO registration_requests (roll_no, phone, status, created_at, decided_at, decided_by) VALUES (?, ?, 'approved', ?, ?, 'test-accounts script')", roll, phone, now, now);
      made.push([roll, raw]);
    }
  });
  await audit({ admin: { email: 'test-accounts script' } }, 'test_accounts.added', made.map((m) => m[0]).join(','));
  console.log('\nTest students ready (approved). ' + (password ? 'Log in at /login with the NIAT ID and the password you gave.' : 'Log in at /login with "Log in with a code" (SMS), then set a password.') + '\n');
  for (const [roll, p] of made) console.log('  ' + roll + '   ' + p);
  console.log('\nThey are hidden from the production leaderboard. Remove them before the real Sprint:\n  node scripts/test-accounts.js remove\n');
} else if (cmd === 'universities') {
  // One approved student per university, with the university set so each lands on its own university's leaderboard.
  await tx(async () => {
    for (const t of TEST_UNIVERSITY_STUDENTS) {
      await run(`INSERT INTO students_master (roll_no, name, phone, batch, email, university, active, source, updated_at) VALUES (?, ?, '', 'TEST', '', ?, 1, 'admin', ?)
                 ON CONFLICT (roll_no) DO UPDATE SET name = excluded.name, batch = 'TEST', university = excluded.university, active = 1, source = 'admin', updated_at = excluded.updated_at`,
        t.roll, t.name, t.university, now);
      await run("DELETE FROM sessions WHERE kind = 'student' AND subject_id IN (SELECT id FROM users WHERE roll_no = ?)", t.roll);
      await run('DELETE FROM users WHERE roll_no = ?', t.roll);
      await run('INSERT INTO users (roll_no, phone, status, created_at, password_hash, password_set_at) VALUES (?, ?, ?, ?, ?, ?)', t.roll, '', 'active', now, password ? hashPassword(password) : null, password ? now : null);
    }
  });
  await audit({ admin: { email: 'test-accounts script' } }, 'test_accounts.universities', TEST_UNIVERSITY_STUDENTS.map((t) => t.roll).join(','));
  console.log('\nUniversity test students ready. Log in at /login with the NIAT ID and the name' + (password ? ' (or the password you gave)' : '') + '.\n');
  for (const t of TEST_UNIVERSITY_STUDENTS) console.log('  ' + t.roll.padEnd(16) + t.name.padEnd(20) + t.university);
  console.log('\nThey are hidden from the production leaderboard. Remove them before the real Sprint:\n  node scripts/test-accounts.js remove\n');
} else if (cmd === 'list') {
  const rows = await all(`SELECT m.roll_no, m.phone, m.university, m.active, u.status AS account,
      (SELECT COUNT(*) FROM attempts a WHERE a.roll_no = m.roll_no) AS attempts FROM students_master m LEFT JOIN users u ON u.roll_no = m.roll_no
    WHERE m.batch = 'TEST' ORDER BY m.roll_no`);
  if (!rows.length) console.log('No test students.');
  for (const r of rows) console.log(`  ${r.roll_no}  ${r.phone || '-'}  ${r.active ? 'active' : 'inactive'}  account: ${r.account || 'none'}  attempts: ${r.attempts}${r.university ? '  ' + r.university : ''}`);
} else if (cmd === 'remove') {
  const rolls = (await all("SELECT roll_no FROM students_master WHERE batch = 'TEST'")).map((r) => r.roll_no);
  await tx(async () => {
    for (const roll of rolls) {
      await run("DELETE FROM sessions WHERE kind = 'student' AND subject_id IN (SELECT id FROM users WHERE roll_no = ?)", roll);
      for (const t of ['users', 'registration_requests', 'attempts', 'progress', 'feedback', 'otp_codes']) await run(`DELETE FROM ${t} WHERE roll_no = ?`, roll);
      await run('DELETE FROM students_master WHERE roll_no = ?', roll);
    }
  });
  await audit({ admin: { email: 'test-accounts script' } }, 'test_accounts.removed', rolls.join(','));
  console.log(`Removed ${rolls.length} test student(s) and all their data.`);
} else {
  console.error('Usage: node scripts/test-accounts.js add --phones 98…,91… | universities | list | remove');
  process.exit(1);
}
await close();
