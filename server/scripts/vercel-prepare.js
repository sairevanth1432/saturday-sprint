// Run before `vercel deploy` from the server/ folder. The Vercel CLI uploads only this folder, but the build also
// needs files from the "Saturday Sprint" folder above it: the portal HTML and the unit files in content/units.json.
// This copies them into server/portal-source/ and server/site-files/ (both are ignored by git; see .vercelignore).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.resolve(ROOT, '..');
const copyKeepTime = (src, dest) => {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  const st = fs.statSync(src);
  fs.utimesSync(dest, st.atime, st.mtime);
};

// 1. newest portal HTML
const portals = fs.readdirSync(SITE).filter((f) => /^saturday_sprint_portal.*\.html$/i.test(f))
  .map((f) => ({ f, m: fs.statSync(path.join(SITE, f)).mtimeMs })).sort((a, b) => b.m - a.m);
if (!portals.length) throw new Error('No saturday_sprint_portal*.html found in ' + SITE);
fs.rmSync(path.join(ROOT, 'portal-source'), { recursive: true, force: true });
copyKeepTime(path.join(SITE, portals[0].f), path.join(ROOT, 'portal-source', portals[0].f));
console.log('portal  →', 'portal-source/' + portals[0].f);

// 2. every file the units refer to
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'units.json'), 'utf8'));
const files = new Set();
for (const u of manifest.units || []) {
  for (const step of [u.watch, u.play, u.read]) {
    if (!step) continue;
    if (step.file) files.add(step.file);
    if (step.source) files.add(String(step.source).split('#')[0]);
  }
}
fs.rmSync(path.join(ROOT, 'site-files'), { recursive: true, force: true });
let bytes = 0;
for (const rel of files) {
  const src = path.resolve(SITE, rel);
  if (!src.startsWith(SITE + path.sep) || !fs.existsSync(src)) throw new Error('content/units.json refers to a missing file: ' + rel);
  copyKeepTime(src, path.join(ROOT, 'site-files', rel));
  bytes += fs.statSync(src).size;
}
console.log(`units   → site-files/ (${files.size} files, ${(bytes / 1048576).toFixed(1)} MB)`);
