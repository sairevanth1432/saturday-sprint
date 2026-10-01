// Import the student master file (Excel .xlsx or CSV; NIAT ID + phone) into the database from any computer.
//   npm run import-students -- path/to/students.xlsx           (replace: students missing from the file are deactivated)
//   npm run import-students -- path/to/students.csv --merge    (add/update only)
// For production, put the production DATABASE_URL in server/.env (or run `vercel env pull .env.local`) first.
import fs from 'node:fs';
import path from 'node:path';
import { ready, close, dbKind } from '../db.js';
import { importStudents, logImport } from '../students.js';

const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
const merge = process.argv.includes('--merge');
if (!file || !fs.existsSync(file)) { console.error('Usage: npm run import-students -- path/to/students.xlsx|.csv [--merge]'); process.exit(1); }

await ready();
console.log(`Importing ${file} into ${dbKind()} (${merge ? 'merge' : 'replace'})…`);
const r = await importStudents({ path: file }, { source: merge ? 'admin' : 'file', fileName: path.basename(file), fullSync: !merge });
logImport(path.basename(file), r);
if (r.errors && r.errors.length) {
  console.log('\nRejected rows:');
  for (const e of r.errors.slice(0, 50)) console.log(`  line ${e.line}  ${e.roll || '-'}  ${e.error}`);
  if (r.errors.length > 50) console.log(`  … and ${r.errors.length - 50} more (see Admin → Master data)`);
}
await close();
process.exit(r.error ? 1 : 0);
