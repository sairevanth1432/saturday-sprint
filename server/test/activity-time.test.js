// Time on portal counts only time the student is present (public/portal-bridge.js, ssActTick).
// Each scenario drives the real portal code with a fake clock and checks the seconds it would report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAll } from './activity-sim.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('time on portal: only time the student is present counts', async () => {
  const res = await runAll(fs.readFileSync(path.join(here, '..', 'public', 'portal-bridge.js'), 'utf8'));
  for (const r of res) assert.equal(r.got, r.expected, r.name);
});
