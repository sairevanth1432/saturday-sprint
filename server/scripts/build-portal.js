// Builds public/portal.html from the single-file portal export and wires it to this server.
//
//   npm run build:portal                      uses the newest ../saturday_sprint_portal*.html
//   npm run build:portal -- "path/to/file.html"
//
// What it does (re-run it whenever the portal HTML is updated):
//   1. Extracts the Sprint test (questions + answers + hidden tests) into data/sprint-test.json (server only)
//      and removes it from the page, so answers never reach the browser.
//   2. Adds the Leaderboard tab, the post-test leaderboard, and the user/logout block.
//   3. Replaces the boot call with /portal-bridge.js (login session, autosave, server grading, progress sync).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, config } from '../config.js';

// Looks in server/portal-source/ first, then the folder above server/ (on Vercel, keep
// "Include files outside the root directory" enabled, or put the HTML in server/portal-source/).
function findSource() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  const found = [];
  for (const [rank, dir] of [[1, path.resolve(ROOT, '..')], [0, path.join(ROOT, 'portal-source')]]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (/^saturday_sprint_portal.*\.html$/i.test(f)) found.push({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs, rank });
  }
  found.sort((a, b) => b.m - a.m || b.rank - a.rank); // newest wins; on a tie the original next to server/ wins
  if (found.length) return found[0].f;
  throw new Error('No saturday_sprint_portal*.html found in server/portal-source/ or the folder above server/. Pass the path explicitly.');
}

fs.mkdirSync(path.join(ROOT, 'generated'), { recursive: true });
const src = findSource();
let html = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
console.log('Source:', src);

function replaceOnce(anchor, replacement, label) {
  const i = html.indexOf(anchor);
  if (i < 0) throw new Error(`Patch "${label}": anchor not found. The portal HTML changed; update scripts/build-portal.js.`);
  if (html.indexOf(anchor, i + anchor.length) >= 0) throw new Error(`Patch "${label}": anchor is not unique.`);
  html = html.slice(0, i) + (typeof replacement === 'function' ? replacement(anchor) : replacement) + html.slice(i + anchor.length);
}

// ---------- 1. move the Sprint test to the server
const START = '\n  test = [';
const s = html.indexOf(START);
if (s < 0) throw new Error('Could not find "test = [" in the portal class.');
const e = html.indexOf('\n  ];', s);
const arrText = html.slice(s + '\n  test = '.length, e + '\n  ]'.length);
const test = vm.runInNewContext('(' + arrText + ')', {}, { timeout: 2000 });
if (!Array.isArray(test) || !test.length) throw new Error('Sprint test array is empty.');
test.forEach((q, i) => {
  const where = `Sprint question ${i + 1}`;
  if (!['mcq', 'code', 'text'].includes(q.type)) throw new Error(`${where}: unknown type ${q.type}`);
  if (q.type === 'mcq' && !(Array.isArray(q.o) && Number.isInteger(q.c) && q.c >= 0 && q.c < q.o.length)) throw new Error(`${where}: MCQ needs options "o" and a valid answer index "c"`);
  if (q.type === 'code' && !(Array.isArray(q.tests) && q.tests.length)) throw new Error(`${where}: coding question needs "tests"`);
});
// content/sprint.json chooses which question types go into the test (e.g. only MCQs).
const sprintCfgFile = path.join(ROOT, 'content', 'sprint.json');
const keepTypes = fs.existsSync(sprintCfgFile) ? JSON.parse(fs.readFileSync(sprintCfgFile, 'utf8')).questionTypes : null;
const dropped = keepTypes ? test.filter((q) => !keepTypes.includes(q.type)) : [];
const testOut = keepTypes ? test.filter((q) => keepTypes.includes(q.type)) : test;
if (!testOut.length) throw new Error('content/sprint.json leaves no questions in the Sprint test.');
if (dropped.length) console.log('Sprint test: left out ' + dropped.length + ' question(s) of type ' + [...new Set(dropped.map((q) => q.type))].join(', ') + ' (content/sprint.json)');
fs.writeFileSync(config.sprintTestFile, JSON.stringify(testOut, null, 2));
html = html.slice(0, s) + '\n  test = []; // served by /api/sprint (answers stay on the server)' + html.slice(e + '\n  ];'.length);
const counts = testOut.reduce((c, q) => ((c[q.type] = (c[q.type] || 0) + 1), c), {});
console.log(`Sprint test → ${path.relative(ROOT, config.sprintTestFile)} (${testOut.length} questions: ${Object.entries(counts).map(([k, v]) => v + ' ' + k).join(', ')})`);

// ---------- 1b. practice question catalogue for the admin "Practice analytics" view
// Students' answers are saved in progress.data: pPick[gi] (gi = index in practice ++ ccbpQuiz ++ genaiQuiz)
// and solved[id] for coding problems. The page keeps its copy; this file only names the questions for the admin.
function classArray(name) {
  const m = new RegExp('\\n  ' + name + ' = \\[').exec(html);
  if (!m) return null;
  let k = m.index + m[0].length - 1, depth = 0, q = null;
  const from = k;
  for (; k < html.length; k++) {
    const ch = html[k];
    if (q) { if (ch === '\\') k++; else if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') q = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') { depth--; if (depth === 0) break; }
  }
  return vm.runInNewContext('(' + html.slice(from, k + 1) + ')', {}, { timeout: 2000 });
}
{
  const parts = ['practice', 'ccbpQuiz', 'genaiQuiz'].map((n) => classArray(n) || []);
  const quiz = [].concat(...parts).map((q, gi) => ({ gi, course: q.course || '', sess: q.sess || '', q: q.q || '', o: q.o || [], c: q.c, multi: !!q.multi, code: q.code || '' }))
    .filter((q) => q.sess && ['pf', 'genai', 'wad'].includes(q.course)); // the courses and sessions the Practice tab shows
  const code = (classArray('ccbpCoding') || []).map((c) => ({ id: c.id, topic: c.topic || '', title: c.title || c.id }));
  const total = parts.reduce((n, p) => n + p.length, 0); // admin-added MCQs follow these (gi = total + n)
  fs.writeFileSync(path.join(ROOT, 'generated', 'practice.json'), JSON.stringify({ quiz, code, total }));
  console.log('Practice catalogue → generated/practice.json (' + quiz.length + ' quiz, ' + code.length + ' coding)');
}

// ---------- 1b. lesson / concept catalog (for learning-byte videos)
function classField(name, open = '[', close = ']') {
  const start = html.indexOf(`\n  ${name} = ${open}`);
  if (start < 0) return null;
  const end = html.indexOf(`\n  ${close};`, start);
  return vm.runInNewContext('(' + html.slice(start + `\n  ${name} = `.length, end + `\n  ${close}`.length) + ')', {}, { timeout: 2000 });
}
const courseSrc = /courseList\(\)\s*\{\s*return\s*\[([\s\S]*?)\];\s*\}/.exec(html);
if (!courseSrc) throw new Error('Could not find courseList() in the portal.');
const courses = [...courseSrc[1].matchAll(/\{\s*id:\s*'([^']+)',\s*name:\s*'([^']+)'[^}]*?modules:\s*this\.(\w+)\s*\}/g)].map((m) => ({ id: m[1], name: m[2], field: m[3] }));
const xpText = classField('xpText', '{', '}') || {};
const lessonsOut = [];
for (const c of courses) {
  const mods = classField(c.field) || [];
  mods.forEach((m) => m.lessons.forEach((l) => {
    lessonsOut.push({
      id: l.id, course: c.id, courseName: c.name, module: m.name, title: l.title, goal: l.goal || '',
      concept: (xpText[l.id] && xpText[l.id].goal) || '', kind: l.kind, hasExplainer: html.includes(`\n    ${l.id}: { scenes`)
    });
  }));
}
// ---------- 1c. units from content/units.json: one lesson per unit with three steps, Watch (MP4) → Play (HTML) → Read (HTML)
// Files are copied into public/packs/ so this server (or the CDN) serves them: no cloud storage needed.
{
  const manifestFile = path.join(ROOT, 'content', 'units.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {};
  const units = manifest.units || [], mode = manifest.mode === 'replace' ? 'replace' : 'append';
  const SITE = path.resolve(ROOT, '..');               // the "Saturday Sprint" folder
  const PACKS = path.join(ROOT, 'public', 'packs');
  fs.rmSync(PACKS, { recursive: true, force: true });
  // "replace": courses that get units here lose their original units (and those lessons leave the admin catalog).
  if (mode === 'replace') {
    const replaced = new Set(units.map((u) => u.course));
    for (let i = lessonsOut.length - 1; i >= 0; i--) if (replaced.has(lessonsOut[i].course)) lessonsOut.splice(i, 1);
  }
  const taken = new Set(lessonsOut.map((l) => l.id));
  const courseName = Object.fromEntries(courses.map((c) => [c.id, c.name]));
  // Unit files come from the "Saturday Sprint" folder, or from server/site-files/ (copied there by scripts/vercel-prepare.js).
  const SITE_FILES = path.join(ROOT, 'site-files');
  const locate = (rel) => {
    for (const base of [SITE, SITE_FILES]) { const f = path.resolve(base, rel); if (f.startsWith(base + path.sep) && fs.existsSync(f)) return f; }
    return null;
  };
  const copy = (rel, what) => {
    const src = locate(rel);
    if (!src) throw new Error(`content/units.json: ${what} file not found: ${rel}`);
    const safe = rel.split(/[\\/]/).map((p) => p.replace(/[^A-Za-z0-9._-]+/g, '-')).join('/');
    const dest = path.join(PACKS, safe);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return '/packs/' + safe + '?v=' + Math.floor(fs.statSync(src).mtimeMs / 1000);
  };
  // Reading notes: the bullet points of a markdown section (e.g. scripts.md#For Loop) as a page in the portal's style.
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const inline = (t) => esc(t).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  function readingPage(l, u) {
    const [file, heading] = String(l.source || '').split('#');
    const mdPath = file ? locate(file) : null;
    if (!mdPath) throw new Error(`content/units.json: reading source not found: ${l.source}`);
    const lines = fs.readFileSync(mdPath, 'utf8').split(/\r?\n/);
    const norm = (x) => x.replace(/^##\s+/, '').replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase();
    const start = lines.findIndex((x) => /^##\s/.test(x) && norm(x) === String(heading || '').trim().toLowerCase());
    if (start < 0) throw new Error(`content/units.json: section "${heading}" not found in ${file}`);
    const points = [];
    for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
      const m = /^\s*[-*]\s+(.*)$/.exec(lines[i]);
      if (!m) continue;
      const lab = /^\*\*[^*·]*·\s*([^*]*)\*\*\s*/.exec(m[1]);          // "**0:04 · Step 1** text" → label "Step 1"
      points.push({ label: lab && lab[1].trim() !== '—' ? lab[1].trim() : '', text: lab ? m[1].slice(lab[0].length) : m[1] });
    }
    if (!points.length) throw new Error(`content/units.json: no bullet points under "${heading}" in ${file}`);
    const cards = points.map((pt, i) => `<article class="card"><div class="k">${esc(pt.label || (i === 0 ? 'The idea' : 'Remember'))}</div><p>${inline(pt.text)}</p></article>`).join('\n');
    const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(l.title)}</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700;800&family=Silkscreen:wght@700&family=VT323&display=swap" rel="stylesheet">
<style>
body{margin:0;background:#0A0A0A;color:#EDEDED;font-family:"JetBrains Mono",system-ui,sans-serif}
main{max-width:820px;margin:0 auto;padding:28px 22px 48px;display:flex;flex-direction:column;gap:14px}
.kicker{font-family:VT323,monospace;font-size:20px;color:#FFE45C}
h1{margin:0;font-family:Silkscreen,monospace;font-size:30px;line-height:1.05;color:#FFF}
.lead{margin:4px 0 6px;font-size:16px;line-height:1.6;color:#BDBDBD}
.card{background:#151515;border-radius:16px;padding:16px 20px;box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 3px 0 #000}
.card .k{font-family:VT323,monospace;font-size:19px;color:#FFE45C;margin-bottom:4px}
.card p{margin:0;font-size:17px;line-height:1.6}
code{font-family:VT323,monospace;font-size:20px;color:#FFE45C}
</style></head><body><main>
<div class="kicker">~/read · ${esc(u.title)}</div>
<h1>${esc(u.title)}</h1>
${u.byte && u.byte.concept ? `<p class="lead">${inline(u.byte.concept)}</p>` : ''}
${cards}
</main></body></html>`;
    const dest = path.join(PACKS, 'readings', l.id + '.html');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, page);
    return '/packs/readings/' + l.id + '.html?v=' + Math.floor(fs.statSync(mdPath).mtimeMs / 1000);
  }

  const out = [];
  for (const u of units) {
    if (!courseName[u.course]) throw new Error(`content/units.json: unknown course "${u.course}" (use ${Object.keys(courseName).join(' or ')})`);
    if (!/^[a-z0-9-]{2,60}$/.test(u.id || '') || taken.has(u.id)) throw new Error(`content/units.json: unit id "${u.id}" is missing, invalid or already used`);
    taken.add(u.id);
    const tabs = {
      watch: u.watch && u.watch.file ? { src: copy(u.watch.file, 'watch'), orientation: u.watch.orientation || 'landscape' } : null,
      play: u.play && u.play.file ? { src: copy(u.play.file, 'play') } : null,
      read: u.read && u.read.file ? { src: copy(u.read.file, 'read') } : u.read && u.read.source ? { src: readingPage({ id: u.id + '-read', title: 'Read: ' + u.title, source: u.read.source }, { title: u.title, byte: u.watch }) } : null
    };
    const goal = (u.watch && u.watch.goal) || '';
    // kind 'video' + a watch source makes the portal show its media area; the bridge switches it per step.
    out.push({ id: u.id, course: u.course, name: u.title, color: u.color || '#FFE45C', practiceTopic: u.practiceTopic || '', lessons: [{
      id: u.id, kind: 'video', title: u.title, goal, tabs,
      watch: tabs.watch ? { type: 'video', src: tabs.watch.src, title: u.title, orientation: tabs.watch.orientation } : { type: 'video', src: '', title: u.title }
    }] });
    lessonsOut.push({ id: u.id, course: u.course, courseName: courseName[u.course], module: u.title, title: u.title, goal, concept: (u.watch && u.watch.concept) || '',
      kind: 'unit', hasExplainer: false, defaults: { watch: tabs.watch && tabs.watch.src, play: tabs.play && tabs.play.src, read: tabs.read && tabs.read.src } });
  }
  fs.writeFileSync(path.join(ROOT, 'generated', 'units.json'), JSON.stringify({ mode, units: out }, null, 2));
  console.log(`Units       → ${out.length} unit(s) from content/units.json (${mode === 'replace' ? 'replacing the original units' : 'after the original units'}); steps: watch → play → read`);
}
fs.writeFileSync(config.lessonsFile, JSON.stringify(lessonsOut, null, 2));

// ---------- 1d. next Sprint: the scheduled switch (content/sprint.json "next") and its topics for the Learn page
{
  const cfg = fs.existsSync(sprintCfgFile) ? JSON.parse(fs.readFileSync(sprintCfgFile, 'utf8')) : {};
  const n = cfg.next || null;
  if (n) {
    if (!/^[A-Za-z0-9._-]{2,60}$/.test(n.id || '')) throw new Error('content/sprint.json: next.id must be 2–60 letters, digits, dots, dashes or underscores.');
    const o = Date.parse(n.open), c = Date.parse(n.close), d = Number(n.durationMin);
    if (!(o < c) || !(d >= 1 && d <= 600)) throw new Error('content/sprint.json: next needs open < close and durationMin between 1 and 600.');
    console.log(`Next Sprint → ${n.id}: ${new Date(o).toISOString()} – ${new Date(c).toISOString()}, ${d} min (applied once the current Sprint has closed)`);
  }
  fs.writeFileSync(path.join(ROOT, 'generated', 'sprint-schedule.json'), JSON.stringify(n));
  // Coding practice honeypots (content/integrity.json): trap text, tokens and thresholds, read by integrity.js.
  const integ = path.join(ROOT, 'content', 'integrity.json');
  if (fs.existsSync(integ)) {
    const ic = JSON.parse(fs.readFileSync(integ, 'utf8'));
    for (const [id, t] of [['trap', ic.trap], ...Object.entries(ic.questions || {})])
      if (!t || !t.instruction || !Array.isArray(t.tokens) || !t.tokens.length || t.tokens.some((k) => !String(k).trim()))
        throw new Error(`content/integrity.json: "${id}" needs an instruction and at least one non-empty token.`);
    fs.writeFileSync(path.join(ROOT, 'generated', 'integrity.json'), JSON.stringify(ic));
    console.log('Integrity   → ' + (ic.enabled === false ? 'off' : 'on') + ' (trap tokens: ' + ic.trap.tokens.join(', ') + ')');
  }
  // Question sets for named Sprints (content/sprint-sets/<sprintId>.json): used instead of the portal's set for
  // that Sprint ID until an admin builds one in Admin → Sprint questions.
  const SETS = path.join(ROOT, 'content', 'sprint-sets'), OUT = path.join(ROOT, 'generated', 'sprint-sets');
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.existsSync(SETS) ? fs.readdirSync(SETS).filter((x) => x.endsWith('.json')) : []) {
    const set = JSON.parse(fs.readFileSync(path.join(SETS, f), 'utf8'));
    if (!Array.isArray(set) || !set.length) throw new Error(`content/sprint-sets/${f}: needs a list of questions.`);
    set.forEach((q, i) => {
      const where = `content/sprint-sets/${f} question ${i + 1}`;
      if (!['mcq', 'code'].includes(q.type)) throw new Error(`${where}: type must be "mcq" or "code".`);
      if (!['pf', 'genai', 'wad'].includes(q.course)) throw new Error(`${where}: course must be pf, genai or wad.`);
      if (q.type === 'code') {
        // Python coding problem: tests are [input, expected output] pairs; sample is shown to the student
        if (!(Array.isArray(q.tests) && q.tests.length && q.tests.every((t) => Array.isArray(t) && t.length === 2 && t.every((x) => typeof x === 'string')))) throw new Error(`${where}: coding question needs "tests" as [input, output] pairs.`);
        if (!(Array.isArray(q.sample) && q.sample.length === 2)) throw new Error(`${where}: coding question needs a "sample" [input, output].`);
        return;
      }
      if (!(Array.isArray(q.o) && q.o.length >= 2 && q.o.length <= 6 && Number.isInteger(q.c) && q.c >= 0 && q.c < q.o.length)) throw new Error(`${where}: needs 2–6 options "o" and a valid answer index "c".`);
      if (new Set(q.o.map((o) => String(o).toLowerCase())).size !== q.o.length) throw new Error(`${where}: two options are the same.`);
    });
    fs.writeFileSync(path.join(OUT, f), JSON.stringify(set, null, 2));
    const lv = set.reduce((c, q) => ((c[q.level || '?'] = (c[q.level || '?'] || 0) + 1), c), {});
    console.log(`Sprint set  → ${f.replace(/\.json$/, '')}: ${set.length} questions (${Object.entries(lv).map(([k, v]) => v + ' ' + k).join(', ')})`);
  }
  const topicsFile = path.join(ROOT, 'content', 'next-sprint.json');
  const t = fs.existsSync(topicsFile) ? JSON.parse(fs.readFileSync(topicsFile, 'utf8')) : null;
  const topics = t && Array.isArray(t.groups) ? { title: String(t.title || 'Next Sprint topics'), groups: t.groups.map((g) => ({ name: String(g.name), topics: (g.topics || []).map(String) })) } : null;
  fs.writeFileSync(path.join(ROOT, 'generated', 'next-sprint.json'), JSON.stringify(topics));
}
console.log(`Lessons     → ${path.relative(ROOT, config.lessonsFile)} (${lessonsOut.length} lessons in ${courses.length} courses)`);

// Videos dropped in public/learning-bytes/<lessonId>.mp4 (manifest used on Vercel, where the folder is not readable at runtime)
{
  const { scanFolder } = await import('../media.js');
  fs.mkdirSync(config.learningBytesDir, { recursive: true });
  const found = scanFolder(config.learningBytesDir);
  fs.writeFileSync(config.folderBytesFile, JSON.stringify(found, null, 2));
  const ids = new Set(lessonsOut.map((l) => l.id));
  const stray = fs.readdirSync(config.learningBytesDir).filter((f) => /\.(mp4|webm)$/i.test(f) && !ids.has(f.replace(/\.(mp4|webm)$/i, '')));
  console.log(`Videos      → ${Object.keys(found).length} learning byte(s) in public/learning-bytes/` + (stray.length ? ` (ignored, no such lesson: ${stray.join(', ')})` : ''));
}

// ---------- 1g. Practice questions kept in the repository (content/practice-import/*.json, Admin "Import JSON" format)
// → generated/practice-seed.json. The server imports them once per change (practiceq.js seedPractice).
{
  const dir = path.join(ROOT, 'content', 'practice-import'), out = path.join(ROOT, 'generated', 'practice-seed.json');
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  if (names.length) {
    const files = names.map((f) => { const json = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { name: f, json }; });
    fs.writeFileSync(out, JSON.stringify({ files }));
    const n = (k) => files.reduce((s, f) => s + (f.json[k] || []).reduce((t, set) => t + (set.questions || []).length, 0), 0);
    console.log(`Practice    → ${n('mcq_practice')} MCQ(s) and ${n('coding_practice')} coding problem(s) from content/practice-import (${files.length} file(s))`);
  } else if (fs.existsSync(out)) fs.unlinkSync(out);
}

// ---------- 1h. Hiring questions for the Practice "Hiring" tab (content/hiring-questions.json → generated/, served by GET /api/hiring-questions)
{
  const src = path.join(ROOT, 'content', 'hiring-questions.json');
  if (fs.existsSync(src)) {
    const h = JSON.parse(fs.readFileSync(src, 'utf8'));
    if (!Array.isArray(h.topics)) throw new Error('content/hiring-questions.json: needs a "topics" list.');
    fs.writeFileSync(path.join(ROOT, 'generated', 'hiring-questions.json'), JSON.stringify(h));
    console.log(`Hiring      → ${h.topics.reduce((n, t) => n + t.questions.length, 0)} interview question(s) in ${h.topics.length} topic(s)`);
  }
}

// ---------- 2. boot through the bridge
const bootRe = /\n\/\*[^\n]*preview=1[^\n]*\*\/\n?bootPortal\(Component[^\n]*\n|\nbootPortal\(Component[^\n]*\n/;
if (!bootRe.test(html)) throw new Error('Could not find the bootPortal(Component, …) call.');
html = html.replace(bootRe, '\n/* Booted by /portal-bridge.js after login (see server/public/portal-bridge.js). */\n');
const bodyEnd = html.lastIndexOf('</body>');
html = html.slice(0, bodyEnd) + '<script src="/photo.js"></script>\n<script src="/portal-bridge.js"></script>\n' + html.slice(bodyEnd);

// ---------- 3. template additions
const ICON_BOARD = '<svg style="flex-shrink: 0" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8"></path><path d="M12 17v4"></path><path d="M7 4h10v5a5 5 0 0 1-10 0z"></path><path d="M17 5h3v2a3 3 0 0 1-3 3"></path><path d="M7 5H4v2a3 3 0 0 0 3 3"></path></svg>';
const ICON_OUT = '<svg style="flex-shrink: 0" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path><path d="M10 17l5-5-5-5"></path><path d="M15 12H3"></path></svg>';

const ICON_HELP = '<svg style="flex-shrink: 0" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"></path><path d="M12 17h.01"></path></svg>';

const ICON_SOUND = '<svg style="flex-shrink: 0" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5L6 9H2v6h4l5 4z"></path><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M19 5a9 9 0 0 1 0 14"></path></svg>';
// Pixel runner (two frames, .f1/.f2 alternate in CSS), trophy and flame for the Home track and the "pacing" loaders.
const FLAME = "<svg width=\"14\" height=\"18\" viewBox=\"0 0 14 18\" aria-hidden=\"true\" style=\"flex-shrink: 0\"><path d=\"M7 1C9.5 4.5 11.5 7 10 11c-.8 2-4 2.4-5.2.6C3.6 9.8 4.3 8 5.4 6.6 5 9 6.8 9.8 7 7.6 8.6 9.6 8.8 11 8 12.4 10.2 11.6 11 9.4 10.2 7.6 10.9 8.4 11.6 9.4 11.6 11c0 3-2.2 5-4.6 5S2.4 14 2.4 11C2.4 7.6 5.4 5.2 7 1Z\" fill=\"currentColor\"></path></svg>";

const NAV_FOCUS = `<div style="margin-top: auto; display: flex; flex-direction: column; gap: 6px">
<button class="k3" onClick="{{ ss.focus.toggle }}" aria-pressed="{{ ss.focus.on }}" aria-label="{{ ss.focus.label }}" title="{{ ss.focus.label }}" style="display: flex; align-items: center; justify-content: {{ side.jc }}; gap: 12px; min-height: 44px; padding: 0 14px; border: 0; border-radius: 12px; background: transparent; box-shadow: none; color: {{ ss.focus.fg }}; font-size: 14px; font-weight: 700; text-align: left">
<sc-if value="{{ ss.focus.off }}" hint-placeholder-val="{{ true }}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M16 3h3a2 2 0 0 1 2 2v3"></path><path d="M8 21H5a2 2 0 0 1-2-2v-3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path></svg></sc-if><sc-if value="{{ ss.focus.on }}" hint-placeholder-val="{{ false }}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v3a2 2 0 0 1-2 2H3"></path><path d="M21 8h-3a2 2 0 0 1-2-2V3"></path><path d="M3 16h3a2 2 0 0 1 2 2v3"></path><path d="M16 21v-3a2 2 0 0 1 2-2h3"></path></svg></sc-if>
<sc-if value="{{ side.full }}" hint-placeholder-val="{{ true }}"><span style="flex-grow: 1">{{ ss.focus.label }}</span></sc-if>
</button>
</div>`;

replaceOnce('\n</div>\n\n</nav>', '\n</div>\n\n</nav>', 'sidebar');

const BOARD_ROW = (list, as) => `<sc-for list="{{ ${list} }}" as="${as}" hint-placeholder-count="5">
<div style="display: grid; grid-template-columns: 76px minmax(0, 1fr) 150px 130px 92px; align-items: center; gap: 12px; min-height: 56px; padding: 6px 16px; border-radius: 14px; border: 2px solid {{ ${as}.ring }}; background: {{ ${as}.bg }}">
<span style="justify-self: start; min-width: 44px; height: 34px; padding: 0 8px; box-sizing: border-box; border-radius: 10px; border: 2px solid {{ ${as}.rankRing }}; background: {{ ${as}.rankBg }}; color: {{ ${as}.rankFg }}; font-family: 'VT323', monospace; font-size: 22px; display: flex; align-items: center; justify-content: center">{{ ${as}.rank }}</span>
<span style="display: flex; align-items: center; gap: 10px; min-width: 0">
<sc-if value="{{ ${as}.hasPhoto }}" hint-placeholder-val="{{ false }}"><img src="{{ ${as}.photo }}" alt="" loading="lazy" style="width: 38px; height: 38px; flex-shrink: 0; border-radius: 10px; object-fit: cover; background: #050505; border: 2px solid #333333" /></sc-if>
<sc-if value="{{ ${as}.noPhoto }}" hint-placeholder-val="{{ true }}"><span aria-hidden="true" style="width: 38px; height: 38px; flex-shrink: 0; border-radius: 10px; border: 2px dashed #333333; display: flex; align-items: center; justify-content: center; font-weight: 800; color: #8A8A8A">{{ ${as}.initial }}</span></sc-if>
<span style="display: flex; flex-direction: column; min-width: 0">
<span style="font-size: 16px; font-weight: 800; color: #FFFFFF; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ ${as}.name }} <span style="color: #FFE45C">{{ ${as}.youTag }}</span></span>
<span style="font-family: 'VT323', monospace; font-size: 17px; color: #8A8A8A">{{ ${as}.id }}</span>
</span>
</span>
<span style="font-size: 14px; color: #BDBDBD; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ ${as}.batch }}</span>
<span style="font-family: 'VT323', monospace; font-size: 24px; color: #FFE45C; text-align: right">{{ ${as}.score }}</span>
<span style="font-family: 'VT323', monospace; font-size: 22px; color: #EDEDED; text-align: right">{{ ${as}.time }}</span>
</div>
</sc-for>`;

const BOARD_HEAD = `<div style="display: grid; grid-template-columns: 76px minmax(0, 1fr) 150px 130px 92px; gap: 12px; padding: 0 18px; font-size: 13px; font-weight: 800; color: #8A8A8A">
<span>Rank</span><span>Student</span><span>University</span><span style="text-align: right">Score</span><span style="text-align: right">Time</span>
</div>`;

const BOARD_TAB = `<!-- ============ STATUS (auth bridge) ============ -->
<sc-if value="{{ ss.banner.on }}" hint-placeholder-val="{{ false }}">
<div role="status" style="display: flex; align-items: center; gap: 14px; margin: 0 0 18px; padding: 10px 16px; border-radius: 12px; border: 2px dashed #FFE45C; color: #FFE45C; font-size: 14px; font-weight: 700">
<span style="flex-grow: 1">{{ ss.banner.text }}</span>
</div>
</sc-if>
<sc-if value="{{ ss.toast.on }}" hint-placeholder-val="{{ false }}">
<div class="pop" role="alert" style="position: fixed; left: 50%; top: 18px; transform: translateX(-50%); z-index: 70; max-width: 640px; padding: 12px 18px; border-radius: 12px; background: #151515; border: 2px solid {{ ss.toast.ring }}; color: #EDEDED; font-size: 15px; font-weight: 700; box-shadow: 0 18px 40px -12px rgba(0,0,0,.9)">{{ ss.toast.text }}</div>
</sc-if>

<!-- ============ LEADERBOARD ============ -->
<sc-if value="{{ show.board }}" hint-placeholder-val="{{ false }}">
<div style="display: flex; flex-direction: column; gap: 22px; max-width: 1000px">
<div style="display: flex; align-items: flex-end; gap: 24px">
<div style="flex-grow: 1; display: flex; flex-direction: column; gap: 10px">
<div style="font-family: 'VT323', monospace; font-size: 18px; color: #FFE45C">{{ lb.kicker }}</div>
<h2 style="margin: 0; font-family: 'Silkscreen', monospace; font-size: 43px; font-weight: 700; line-height: 0.95">Leaderboard</h2>
<p style="margin: 0; font-size: 15px; line-height: 1.5; color: #BDBDBD; max-width: 720px">{{ lb.rule }}</p>
</div>
<button class="k3" onClick="{{ lb.refresh }}" style="flex-shrink: 0; min-height: 46px; padding: 0 18px; border: 2px solid #333333; border-radius: 12px; background: transparent; color: #FFFFFF; font-size: 15px; font-weight: 700">Refresh</button>
</div>

<div class="well" style="background: #050505; border-radius: 22px; padding: 24px 28px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px">
<div style="display: flex; flex-direction: column; gap: 4px"><span style="font-size: 14px; font-weight: 700; color: #BDBDBD">Your rank</span><span style="font-family: 'VT323', monospace; font-size: 52px; line-height: 1; color: #FFE45C">{{ lb.my.rank }}</span><span style="font-size: 13px; color: #8A8A8A">{{ lb.my.note }}</span></div>
<div style="display: flex; flex-direction: column; gap: 4px"><span style="font-size: 14px; font-weight: 700; color: #BDBDBD">Your score</span><span style="font-family: 'VT323', monospace; font-size: 52px; line-height: 1">{{ lb.my.score }}</span><span style="font-size: 13px; color: #8A8A8A">{{ lb.my.time }}</span></div>
<div style="display: flex; flex-direction: column; gap: 4px"><span style="font-size: 14px; font-weight: 700; color: #BDBDBD">On the board</span><span style="font-family: 'VT323', monospace; font-size: 52px; line-height: 1">{{ lb.participants }}</span><span style="font-size: 13px; color: #8A8A8A">{{ lb.updated }}</span></div>
</div>

<sc-if value="{{ lb.loading }}" hint-placeholder-val="{{ false }}"><div class="blink" style="font-family: 'VT323', monospace; font-size: 22px; color: #8A8A8A">pacing… fetching the board</div></sc-if>
<sc-if value="{{ lb.empty }}" hint-placeholder-val="{{ false }}">
<div class="well" style="background: #050505; border-radius: 22px; padding: 36px; display: flex; flex-direction: column; gap: 8px">
<div style="font-family: 'VT323', monospace; font-size: 20px; color: #FFE45C">0 rows</div>
<div style="font-size: 20px; font-weight: 800">No results yet.</div>
<div style="font-size: 15px; color: #BDBDBD">{{ lb.emptyNote }}</div>
</div>
</sc-if>
<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
<sc-if value="{{ lb.uniLabel }}" hint-placeholder-val="{{ false }}"><span style="font-size: 15px; font-weight: 800; color: #FFE45C; margin-right: 6px">{{ lb.uniLabel }}</span></sc-if>
<sc-if value="{{ lb.hasSprints }}" hint-placeholder-val="{{ false }}"><sc-for list="{{ lb.sprints }}" as="sp" hint-placeholder-count="2"><button class="k3" onClick="{{ sp.go }}" style="min-height: 36px; padding: 0 12px; border: 2px solid #333333; border-radius: 10px; background: {{ sp.bg }}; color: {{ sp.fg }}; font-size: 13px; font-weight: 800">{{ sp.label }}</button></sc-for></sc-if>
</div>
<sc-if value="{{ lb.hasRows }}" hint-placeholder-val="{{ true }}">
<div style="display: flex; flex-direction: column; gap: 8px">
${BOARD_HEAD}
${BOARD_ROW('lb.rows', 'lr')}
</div>
</sc-if>
<sc-if value="{{ lb.meBelow }}" hint-placeholder-val="{{ false }}">
<div style="display: flex; flex-direction: column; gap: 8px">
<div style="font-size: 13px; font-weight: 800; color: #8A8A8A; padding: 0 18px">Your position</div>
${BOARD_ROW('lb.meRows', 'mr')}
</div>
</sc-if>
</div>
</sc-if>

`;
replaceOnce('<!-- ============ HOME (Today) ============ -->', (a) => BOARD_TAB + a, 'leaderboard tab');

// ---------- 3d. Top-right bar: Sprint test, Leaderboard, sound, music, profile menu, more menu. Icon-only, labels on hover (.ss-ib).
const TOPBAR = `<sc-if value="{{ ss.top.show }}" hint-placeholder-val="{{ true }}">
<div class="ss-topbar">
<sc-if value="{{ ss.top.quoteOn }}" hint-placeholder-val="{{ false }}"><div class="ss-topquote">“{{ ss.top.quote }}” <span>— {{ ss.top.by }}</span></div></sc-if>
<button class="ss-ib" onClick="{{ ss.focus.toggle }}" aria-pressed="{{ ss.focus.on }}" aria-label="{{ ss.focus.label }}" data-on="{{ ss.focus.on }}"><sc-if value="{{ ss.focus.off }}" hint-placeholder-val="{{ true }}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M16 3h3a2 2 0 0 1 2 2v3"></path><path d="M8 21H5a2 2 0 0 1-2-2v-3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path></svg></sc-if><sc-if value="{{ ss.focus.on }}" hint-placeholder-val="{{ false }}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v3a2 2 0 0 1-2 2H3"></path><path d="M21 8h-3a2 2 0 0 1-2-2V3"></path><path d="M3 16h3a2 2 0 0 1 2 2v3"></path><path d="M16 21v-3a2 2 0 0 1 2-2h3"></path></svg></sc-if><span class="ss-ib-label">{{ ss.focus.label }}</span></button>
<sc-if value="{{ ss.top.full }}" hint-placeholder-val="{{ true }}">
<button class="ss-ib" onClick="{{ nav.board.go }}" aria-label="Leaderboard" data-on="{{ nav.board.on }}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18"></path><path d="M4 21v-7h5v7"></path><path d="M9.5 21V9h5v12"></path><path d="M15 21v-5h5v5"></path><path d="M12 2.5l1 2 2.2.3-1.6 1.5.4 2.2-2-1.1-2 1.1.4-2.2-1.6-1.5 2.2-.3z"></path></svg><span class="ss-ib-label">Leaderboard</span></button>
<div class="ss-menu-wrap">
<button class="ss-ib" onClick="{{ ss.audio.toggle }}" aria-haspopup="menu" aria-expanded="{{ ss.audio.open }}" aria-label="{{ ss.audio.label }}" data-on="{{ ss.audio.on }}"><sc-if value="{{ ss.audio.on }}" hint-placeholder-val="{{ true }}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10v4h3l5 4V6l-5 4z"></path><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M18.5 5.5a9 9 0 0 1 0 13"></path></svg></sc-if><sc-if value="{{ ss.audio.off }}" hint-placeholder-val="{{ false }}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10v4h3l5 4V6l-5 4z"></path><path d="M16 9l5 6"></path><path d="M21 9l-5 6"></path></svg></sc-if><span class="ss-ib-label">{{ ss.audio.label }}</span></button>
<sc-if value="{{ ss.audio.open }}" hint-placeholder-val="{{ false }}">
<div class="ss-menu pop" role="menu" style="min-width: 200px">
<button class="ss-menu-item" role="menuitemcheckbox" aria-checked="{{ ss.audio.sfxOn }}" onClick="{{ ss.audio.sfxToggle }}" data-on="{{ ss.audio.sfxOn }}"><span class="ss-check" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"></path></svg></span><span>Sound effects</span></button>
<button class="ss-menu-item" role="menuitemcheckbox" aria-checked="{{ ss.audio.musicOn }}" onClick="{{ ss.audio.musicToggle }}" data-on="{{ ss.audio.musicOn }}"><span class="ss-check" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"></path></svg></span><span>Music</span></button>
</div>
</sc-if>
</div>
<div class="ss-menu-wrap">
<button class="ss-ib ss-avatar" onClick="{{ ss.user.menu }}" aria-haspopup="menu" aria-expanded="{{ ss.user.menuOpen }}" aria-label="Profile menu" data-on="{{ ss.user.menuOpen }}">
<sc-if value="{{ ss.user.hasPhoto }}" hint-placeholder-val="{{ false }}"><img src="{{ ss.user.photo }}" alt=""></sc-if>
<sc-if value="{{ ss.user.noPhoto }}" hint-placeholder-val="{{ true }}"><span class="ss-avatar-initial">{{ ss.user.initial }}</span></sc-if>
<span class="ss-ib-label">{{ ss.user.name }}</span>
</button>
<sc-if value="{{ ss.user.menuOpen }}" hint-placeholder-val="{{ false }}">
<div class="ss-menu pop" role="menu">
<div class="ss-menu-head"><span class="ss-menu-name">{{ ss.user.name }}</span><span class="ss-menu-sub">{{ ss.user.sub }}</span></div>
<button class="ss-menu-item" role="menuitem" onClick="{{ ss.more.home }}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-8 9 8"></path><path d="M5 10v10h14V10"></path></svg><span>Home</span></button>
<button class="ss-menu-item" role="menuitem" onClick="{{ ss.more.topics }}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"></path><path d="M4 12h16"></path><path d="M4 18h10"></path></svg><span>Topics</span></button>
<button class="ss-menu-item" role="menuitem" onClick="{{ ss.more.practice }}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 6h10"></path><path d="M10 12h10"></path><path d="M10 18h10"></path><path d="M3.5 6l1.5 1.5L7.5 5"></path><path d="M3.5 12l1.5 1.5L7.5 11"></path><path d="M3.5 18l1.5 1.5L7.5 17"></path></svg><span>Practice</span></button>
<button class="ss-menu-item" role="menuitem" onClick="{{ ss.more.test }}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4"></path><path d="M5 4h13l-1.5 4L18 12H5"></path><path d="M9 4v8"></path><path d="M13 4v8"></path><path d="M5 8h13"></path></svg><span>Sprint test</span></button>
<button class="ss-menu-item" role="menuitem" onClick="{{ ss.more.board }}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21h18"></path><path d="M4 21v-7h5v7"></path><path d="M9.5 21V9h5v12"></path><path d="M15 21v-5h5v5"></path><path d="M12 2.5l1 2 2.2.3-1.6 1.5.4 2.2-2-1.1-2 1.1.4-2.2-1.6-1.5 2.2-.3z"></path></svg><span>Leaderboard</span></button>
<div class="ss-menu-sep"></div>
<button class="ss-menu-item" role="menuitem" onClick="{{ ss.user.open }}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21a8 8 0 1 0-16 0"></path><circle cx="12" cy="8" r="4"></circle></svg><span>Profile · photo and medals</span></button>
<button class="ss-menu-item" role="menuitem" onClick="{{ ss.help }}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"></path><path d="M12 17h.01"></path></svg><span>Help and guide</span></button>
<sc-if value="{{ ss.user.isAdmin }}" hint-placeholder-val="{{ false }}"><button class="ss-menu-item" role="menuitem" onClick="{{ ss.toAdmin }}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"></path></svg><span>Admin console</span></button></sc-if>
<button class="ss-menu-item" role="menuitem" onClick="{{ ss.logout }}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path><path d="M10 17l5-5-5-5"></path><path d="M15 12H3"></path></svg><span>Log out</span></button>
</div>
</sc-if>
</div>
</sc-if>
</div>
</sc-if>
`;
replaceOnce('<main style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column; position: relative">\n', (a) => a + TOPBAR, 'top bar');

// ---------- 3e. Home topic map: the marathon road, one block per topic, the avatar on the current one, the trophy at the end (= Sprint test).
const HOME_MAP = `<sc-if value="{{ map.on }}" hint-placeholder-val="{{ true }}">
<div style="display: flex; flex-direction: column; gap: 14px">
<div style="display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap">
<span style="font-size: 13px; font-weight: 800; color: #FFE45C">Your road</span>
</div>
<div class="ss-map" role="list" aria-label="Topics on the road, in order" style="width: {{ map.w }}; height: {{ map.h }}">
<svg class="ss-map-road" width="{{ map.w }}" height="{{ map.h }}" aria-hidden="true"><path d="{{ map.path }}" fill="none" stroke="#2A2A2A" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"></path><path d="{{ map.path }}" fill="none" stroke="#3A3A3A" stroke-width="2" stroke-dasharray="8 10" stroke-linecap="round" stroke-linejoin="round"></path><path d="{{ map.donePath }}" fill="none" stroke="#FFE45C" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" opacity=".9"></path></svg>
<sc-for list="{{ map.items }}" as="mb" hint-placeholder-count="6">
<button class="ss-map-block" role="listitem" onClick="{{ mb.go }}" aria-current="{{ mb.on }}" title="{{ mb.title }}" style="left: {{ mb.left }}; top: {{ mb.top }}; background: {{ mb.bg }}; color: {{ mb.fg }}; border-color: {{ mb.ring }}"><span class="ss-map-n" style="background: {{ mb.nBg }}; color: {{ mb.nFg }}">{{ mb.n }}</span><span class="ss-map-name">{{ mb.name }}</span></button>
</sc-for>
<button class="ss-map-trophy" onClick="{{ nav.test.go }}" title="Finish line: the Saturday Sprint test" style="left: {{ map.trophy.left }}; top: {{ map.trophy.top }}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8"></path><path d="M12 17v4"></path><path d="M7 4h10v5a5 5 0 0 1-10 0z"></path><path d="M17 5h3v2a3 3 0 0 1-3 3"></path><path d="M7 5H4v2a3 3 0 0 0 3 3"></path></svg></button>
<span class="ss-map-avatar" aria-hidden="true" style="left: {{ map.avatar.left }}; top: {{ map.avatar.top }}"><sc-if value="{{ map.avatar.hasPhoto }}" hint-placeholder-val="{{ false }}"><img src="{{ map.avatar.photo }}" alt=""></sc-if><sc-if value="{{ map.avatar.noPhoto }}" hint-placeholder-val="{{ true }}"><span>{{ map.avatar.initial }}</span></sc-if></span>
</div>
</div>
</sc-if>
`;
replaceOnce('<!-- home road (build-portal.js HOME_MAP) -->\n', HOME_MAP, 'home topic map');

// ---------- 3c. Profile: photo (change it here), streak, medals earned and how to earn the rest. Opened from the sidebar user block.
const PROFILE_TAB = `<!-- ============ PROFILE ============ -->
<sc-if value="{{ show.profile }}" hint-placeholder-val="{{ false }}">
<div class="pop" style="display: flex; flex-direction: column; gap: 36px; padding-top: 24px; max-width: 820px">
<div style="display: flex; flex-direction: column; gap: 6px">
<span style="font-family: 'VT323', monospace; font-size: 20px; color: #FFE45C">~/profile</span>
<h2 style="margin: 0; font-family: 'Silkscreen', monospace; font-size: 30px; font-weight: 700; line-height: 1">Profile</h2>
</div>
<div style="display: flex; align-items: center; gap: 24px; flex-wrap: wrap">
<div style="flex-shrink: 0; width: 112px; height: 112px; border-radius: 20px; overflow: hidden; border: 2px solid #333333; background: #050505; display: flex; align-items: center; justify-content: center">
<sc-if value="{{ pf.hasPhoto }}" hint-placeholder-val="{{ false }}"><img src="{{ pf.photo }}" alt="Your photo" style="display: block; width: 100%; height: 100%; object-fit: cover"></sc-if>
<sc-if value="{{ pf.noPhoto }}" hint-placeholder-val="{{ true }}"><span style="font-family: 'Silkscreen', monospace; font-size: 40px; color: #5E5E5E">{{ pf.initial }}</span></sc-if>
</div>
<div style="display: flex; flex-direction: column; gap: 8px; min-width: 0">
<span style="font-size: 22px; font-weight: 800; color: #FFFFFF">{{ pf.name }}</span>
<span style="font-family: 'VT323', monospace; font-size: 20px; color: #8A8A8A">{{ pf.sub }}</span>
<span style="display: flex; align-items: center; gap: 6px; font-family: 'VT323', monospace; font-size: 20px; color: {{ pf.streakFg }}" title="{{ pf.streakTitle }}">${FLAME}{{ pf.streakLabel }}</span>
<div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px">
<sc-if value="{{ pf.canPhoto }}" hint-placeholder-val="{{ true }}"><button class="k3" onClick="{{ pf.changePhoto }}" style="min-height: 40px; padding: 0 16px; border: 2px solid #333333; border-radius: 12px; background: transparent; color: #FFFFFF; font-size: 14px; font-weight: 700">Change photo</button></sc-if>
<button class="k3" onClick="{{ ss.help }}" aria-label="Help and guide" title="Help and guide" style="display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 14px; border: 2px solid #333333; border-radius: 12px; background: transparent; color: #BDBDBD; font-size: 14px; font-weight: 700"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"></path><path d="M12 17h.01"></path></svg><span>Help</span></button>
<button class="k3" onClick="{{ ss.logout }}" style="display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 14px; border: 2px solid #333333; border-radius: 12px; background: transparent; color: #BDBDBD; font-size: 14px; font-weight: 700"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path><path d="M10 17l5-5-5-5"></path><path d="M15 12H3"></path></svg><span>Log out</span></button>
</div>
</div>
</div>
<div style="display: flex; flex-direction: column; gap: 14px">
<span style="font-size: 13px; font-weight: 800; color: #FFE45C">Medals · {{ pf.earned }}</span>
<div class="ss-medal-grid">
<sc-for list="{{ pf.badges }}" as="bd" hint-placeholder-count="6">
<div class="ss-medal-card" title="{{ bd.title }}" style="border-color: {{ bd.ring }}; opacity: {{ bd.opacity }}">
<span class="ss-medal-icon" style="background: {{ bd.bg }}; color: {{ bd.fg }}"><i class="ss-mi-{{ bd.id }}"></i></span>
<span style="display: flex; flex-direction: column; gap: 2px; min-width: 0">
<span style="font-size: 15px; font-weight: 800; color: #FFFFFF">{{ bd.name }}</span>
<span style="font-family: 'VT323', monospace; font-size: 18px; color: {{ bd.hintFg }}">{{ bd.hint }}</span>
</span>
</div>
</sc-for>
</div>
</div>
</div>
</sc-if>
`;
replaceOnce('<!-- ============ HOME (Today) ============ -->', (a) => PROFILE_TAB + a, 'profile tab');



const DONE_BOARD = `
<sc-if value="{{ ss.submit.failed }}" hint-placeholder-val="{{ false }}">
<div style="display: flex; align-items: center; gap: 14px; padding: 14px 18px; border-radius: 14px; border: 2px solid #FF7A7A; background: rgba(255,122,122,.08)">
<span style="flex-grow: 1; font-size: 15px; font-weight: 700; color: #FF7A7A">{{ ss.submit.error }}</span>
<button class="b3" onClick="{{ ss.submit.retry }}" style="flex-shrink: 0; min-height: 44px; padding: 0 18px; border: 0; border-radius: 12px; background: #FFE45C; color: #050505; font-size: 15px; font-weight: 800">Try again</button>
</div>
</sc-if>
<sc-if value="{{ ss.submit.pending }}" hint-placeholder-val="{{ false }}">
<div class="blink" style="font-family: 'VT323', monospace; font-size: 22px; color: #FFE45C">grading on the server… hold your pace</div>
</sc-if>
<sc-if value="{{ ss.result.on }}" hint-placeholder-val="{{ false }}">
<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px">
<div style="padding: 18px 22px; border: 3px solid #FFFFFF; border-radius: 16px; display: flex; flex-direction: column; gap: 4px">
<div style="font-size: 15px; font-weight: 600; color: #BDBDBD">Total score</div>
<div style="font-family: 'VT323', monospace; font-size: 49px; font-weight: 700">{{ ss.result.score }}</div>
<div style="font-size: 13px; color: #8A8A8A">{{ ss.result.note }}</div>
</div>
<div style="padding: 18px 22px; border: 3px solid #FFFFFF; border-radius: 16px; display: flex; flex-direction: column; gap: 4px">
<div style="font-size: 15px; font-weight: 600; color: #BDBDBD">Your rank</div>
<div style="font-family: 'VT323', monospace; font-size: 49px; font-weight: 700; color: #FFE45C">{{ lb.my.rank }}</div>
<div style="font-size: 13px; color: #8A8A8A">{{ lb.my.note }}</div>
</div>
</div>
<sc-if value="{{ ss.review.on }}" hint-placeholder-val="{{ false }}">
<div style="display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 16px 20px; border: 2px solid #333333; border-radius: 16px; background: #0D0D0D">
<span style="flex-grow: 1; min-width: 220px; font-size: 15px; line-height: 1.5; color: #EDEDED">{{ ss.review.text }}</span>
<button class="b3" onClick="{{ ss.review.open }}" style="flex-shrink: 0; min-height: 46px; padding: 0 20px; border: 0; border-radius: 12px; background: #FFE45C; color: #050505; font-size: 15px; font-weight: 800">{{ ss.review.label }}</button>
</div>
</sc-if>
<sc-if value="{{ ss.again.on }}" hint-placeholder-val="{{ false }}">
<div style="display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 16px 20px; border: 2px dashed #FFE45C; border-radius: 16px">
<span style="flex-grow: 1; min-width: 220px; font-size: 15px; line-height: 1.5; color: #EDEDED">{{ ss.again.text }}</span>
<button class="b3" onClick="{{ ss.again.go }}" style="flex-shrink: 0; min-height: 46px; padding: 0 20px; border: 2px solid #FFE45C; border-radius: 12px; background: transparent; color: #FFE45C; font-size: 15px; font-weight: 800">Take the test again</button>
</div>
</sc-if>
<div style="display: flex; flex-direction: column; gap: 8px">
<div style="display: flex; align-items: baseline; justify-content: space-between; gap: 12px">
<div style="font-size: 20px; font-weight: 800">Leaderboard</div>
<button class="k3" onClick="{{ nav.board.go }}" style="min-height: 40px; padding: 0 14px; border: 2px solid #333333; border-radius: 10px; background: transparent; color: #FFFFFF; font-size: 14px; font-weight: 700">Full leaderboard →</button>
</div>
<sc-if value="{{ lb.empty }}" hint-placeholder-val="{{ false }}"><div style="font-size: 15px; color: #BDBDBD">{{ lb.emptyNote }}</div></sc-if>
<sc-if value="{{ lb.hasRows }}" hint-placeholder-val="{{ true }}">
${BOARD_HEAD}
${BOARD_ROW('lb.top10', 'dr')}
</sc-if>
<sc-if value="{{ lb.meBelow10 }}" hint-placeholder-val="{{ false }}">
${BOARD_ROW('lb.meRows', 'dm')}
</sc-if>
<div style="font-size: 13px; color: #8A8A8A">{{ lb.rule }}</div>
</div>
</sc-if>`;
replaceOnce('\n</div>\n</sc-if>\n\n<!-- closed -->', (a) => DONE_BOARD + a, 'post-test leaderboard');

// ---------- 4. media sizing: upright (portrait) videos and full-height games
replaceOnce('style="display: block; width: 100%; aspect-ratio: 16 / 9; border-radius: 12px; background: #000000"></video>',
  'style="display: block; width: {{ wt.vw }}; aspect-ratio: {{ wt.aspect }}; max-height: 78vh; margin: 0 auto; border-radius: 12px; background: #000000"></video>', 'video sizing');
replaceOnce('<a data-embed="slides" href="{{ wt.src }}"', '<a data-embed="slides" data-tall="{{ wt.tall }}" href="{{ wt.src }}"', 'embed height flag');
replaceOnce("style: 'display:block;width:100%;aspect-ratio:16/9;border:0;border-radius:12px;background:#000' });",
  "style: props['data-tall'] ? 'display:block;width:100%;height:calc(100vh - 290px);min-height:560px;border:0;border-radius:12px;background:#0A0A0A' : 'display:block;width:100%;aspect-ratio:16/9;border:0;border-radius:12px;background:#000' });", 'embed sizing');

// ---------- 4e. Learn: the topics of the next Sprint (content/next-sprint.json), above the lessons; can be folded away
replaceOnce('<!-- ============ LEARN ============ -->\n<sc-if value="{{ show.learn }}" hint-placeholder-val="{{ false }}">\n<div style="display: flex; flex-direction: column; gap: 20px">',
  (a) => a + `
<sc-if value="{{ ss.next.on }}" hint-placeholder-val="{{ false }}">
<section class="d3" aria-label="Next Sprint topics" style="background: #151515; border-radius: 18px; padding: 16px 20px; display: flex; flex-direction: column; gap: 12px">
<div style="display: flex; align-items: center; gap: 14px; flex-wrap: wrap">
<span style="font-family: 'VT323', monospace; font-size: 19px; color: #FFE45C">~/next-sprint</span>
<span style="font-size: 17px; font-weight: 800; color: #FFFFFF">{{ ss.next.title }}</span>
<span style="flex-grow: 1; font-size: 14px; font-weight: 700; color: #BDBDBD">{{ ss.next.when }}</span>
<button class="k3" onClick="{{ ss.next.toggle }}" aria-expanded="{{ ss.next.open }}" style="flex-shrink: 0; min-height: 36px; padding: 0 14px; border: 2px solid #333333; border-radius: 10px; background: transparent; color: #EDEDED; font-size: 13px; font-weight: 800">{{ ss.next.toggleLabel }}</button>
</div>
<sc-if value="{{ ss.next.open }}" hint-placeholder-val="{{ true }}">
<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px">
<sc-for list="{{ ss.next.groups }}" as="ng" hint-placeholder-count="3">
<div class="well" style="background: #050505; border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px">
<span style="font-size: 13px; font-weight: 800; color: #FFE45C">{{ ng.name }}</span>
<sc-for list="{{ ng.topics }}" as="nt" hint-placeholder-count="3">
<span style="display: flex; gap: 8px; font-size: 14px; line-height: 1.4; color: #EDEDED"><span aria-hidden="true" style="color: #5E5E5E">›</span><span>{{ nt.t }}</span></span>
</sc-for>
</div>
</sc-for>
</div>
</sc-if>
</section>
</sc-if>`, 'next sprint topics');

// A friendly "on its way" icon for topics and steps without content yet: a little smiling robot with a sparkle.
function ICON_SOON(px) {
  return `<svg aria-hidden="true" width="${px}" height="${px}" viewBox="0 0 64 64" fill="none" style="flex-shrink: 0">
<path d="M32 6v7" stroke="#FFE45C" stroke-width="3" stroke-linecap="round"></path><circle cx="32" cy="5" r="3.5" fill="#FFE45C"></circle>
<rect x="12" y="13" width="40" height="32" rx="11" fill="#FFE45C"></rect>
<rect x="7" y="24" width="5" height="11" rx="2.5" fill="#9E8618"></rect><rect x="52" y="24" width="5" height="11" rx="2.5" fill="#9E8618"></rect>
<circle cx="24" cy="28" r="4" fill="#050505"></circle><circle cx="40" cy="28" r="4" fill="#050505"></circle>
<circle cx="25.4" cy="26.6" r="1.3" fill="#FFFFFF"></circle><circle cx="41.4" cy="26.6" r="1.3" fill="#FFFFFF"></circle>
<path d="M25 36c2 2.6 4.3 3.8 7 3.8s5-1.2 7-3.8" stroke="#050505" stroke-width="3" stroke-linecap="round"></path>
<circle cx="18.5" cy="35" r="2.6" fill="#FF9E9E" opacity=".75"></circle><circle cx="45.5" cy="35" r="2.6" fill="#FF9E9E" opacity=".75"></circle>
<rect x="22" y="47" width="20" height="10" rx="5" fill="#9E8618"></rect>
<path d="M54 50l1.6 3.4L59 55l-3.4 1.6L54 60l-1.6-3.4L49 55l3.4-1.6z" fill="#FFFFFF"></path>
</svg>`;
}

// ---------- 4b. units: "← Previous" next to the Next button, and a placeholder when a Read step has no notes yet
replaceOnce('<span style="flex-grow: 1; font-size: 14px; font-weight: 700; color: #8A8A8A">{{ cur.stepHint }}</span>',
  `<span style="flex-grow: 1; font-size: 14px; font-weight: 700; color: #8A8A8A">{{ cur.stepHint }}</span>
<sc-if value="{{ ss.prev.on }}" hint-placeholder-val="{{ false }}"><button class="k3" onClick="{{ ss.prev.go }}" style="min-height: 50px; padding: 0 20px; border: 2px solid #333333; border-radius: 14px; background: transparent; color: #FFFFFF; font-size: 16px; font-weight: 800">{{ ss.prev.label }}</button></sc-if>`, 'previous button');
replaceOnce('<sc-if value="{{ recShow }}" hint-placeholder-val="{{ false }}">',
  `<sc-if value="{{ ss.soon.on }}" hint-placeholder-val="{{ false }}">
<div class="well pop" style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; min-height: 360px; padding: 32px; border-radius: 12px; background: #050505; text-align: center">
${ICON_SOON(112)}
<div style="font-family: 'VT323', monospace; font-size: 22px; color: #FFE45C">{{ ss.soon.kicker }}</div>
<div style="font-size: 24px; font-weight: 800; color: #FFFFFF">Will be updated soon</div>
<div style="font-size: 15px; color: #8A8A8A; max-width: 480px; line-height: 1.5">{{ ss.soon.text }}</div>
</div>
</sc-if>
<sc-if value="{{ recShow }}" hint-placeholder-val="{{ false }}">`, 'read placeholder');

// ---------- 4c. Learn topic list: a tick on completed topics instead of the per-lesson progress dots
replaceOnce('<span>{{ lt2.name }}</span><span aria-hidden="true" style="display: flex; gap: 5px"><sc-for list="{{ lt2.dots }}" as="dt" hint-placeholder-count="3"><span style="width: 8px; height: 8px; border-radius: 50%; background: {{ dt.bg }}; box-shadow: inset 0 0 0 1.5px {{ dt.ring }}"></span></sc-for></span></button>',
  `<span style="display: flex; align-items: flex-start; gap: 10px; width: 100%"><span style="flex-grow: 1; display: flex; flex-direction: column; gap: 6px"><span>{{ lt2.name }}</span><sc-if value="{{ lt2.soon }}" hint-placeholder-val="{{ false }}"><span style="display: flex; align-items: center; gap: 6px; font-family: 'VT323', monospace; font-size: 17px; font-weight: 400; color: {{ lt2.soonFg }}">${ICON_SOON(20)}Updated soon</span></sc-if></span><sc-if value="{{ lt2.done }}" hint-placeholder-val="{{ false }}"><span aria-hidden="true" title="Completed" style="flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%; background: {{ lt2.tickBg }}; color: {{ lt2.tickFg }}; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 800">✓</span></sc-if></span></button>`, 'topic list tick');

// ---------- 4d. Learn uses the full width of the screen; Play and Read get a full-screen button
replaceOnce('<div class="d3 pop" style="background: #151515; border-radius: 18px; padding: 16px; display: flex; flex-direction: column; gap: 12px; max-width: 1040px">',
  '<div class="d3 pop" style="background: #151515; border-radius: 18px; padding: 16px; display: flex; flex-direction: column; gap: 12px">', 'learn media width');
replaceOnce('<div style="display: flex; align-items: center; gap: 14px; padding-top: 14px; border-top: 1px solid #1F1F1F; max-width: 1040px">',
  '<div style="display: flex; align-items: center; gap: 14px; padding-top: 14px; border-top: 1px solid #1F1F1F">', 'learn bottom bar width');
// ---------- 4g. NIAT crest beside the Saturday Sprint wordmark in the sidebar, in one row (public/niat-logo.png)
replaceOnce(`<div style="display: flex; flex-direction: column; gap: 6px">
<button class="k3" onClick="{{ nav.brand }}"`,
  `<div style="display: flex; flex-direction: row; align-items: center; gap: 10px">
<img src="/niat-logo.png" alt="NIAT" width="42" height="40" style="display: block; flex-shrink: 0; width: 42px; height: auto; border-radius: 6px" />
<button class="k3" onClick="{{ nav.brand }}"`, 'NIAT crest');
// the wordmark is smaller so both fit the sidebar width
replaceOnce("font-family: 'Silkscreen', monospace; font-weight: 700; font-size: 30px; line-height: 0.95",
  "font-family: 'Silkscreen', monospace; font-weight: 700; font-size: 22px; line-height: 0.95", 'wordmark size');
// ---------- 4h. Sprint wording: "The test is open" while the window is open
replaceOnce("font-weight: 700; line-height: 0.95; \">The Sprint is open.</h2>", "font-weight: 700; line-height: 0.95; \">The test is open.</h2>", 'test open heading');
replaceOnce("headline: 'The Sprint is open now'", "headline: 'The test is open'", 'test open headline');
// ---------- 4e. Learn bottom bar: Previous / Next centred at the bottom of the content (.ss-nav CSS below)
replaceOnce(`<div style="display: flex; align-items: center; gap: 14px; padding-top: 14px; border-top: 1px solid #1F1F1F">
<span style="flex-grow: 1; font-size: 14px; font-weight: 700; color: #8A8A8A">{{ cur.stepHint }}</span>
`, `<div class="ss-nav">
<span class="ss-nav-hint">{{ cur.stepHint }}</span>
<div class="ss-nav-row">
`, 'learn nav bar');
replaceOnce('{{ cur.stepLabel }}</button>\n</div>\n</article>', '{{ cur.stepLabel }}</button>\n</div>\n</div>\n</article>', 'learn nav row end');
// ---------- 4f. Phones cannot take the Sprint test: the Test tab shows this card instead (portal-bridge.js → show.phoneTest)
replaceOnce('<sc-if value="{{ show.test }}" hint-placeholder-val="{{ false }}">', `<sc-if value="{{ show.phoneTest }}" hint-placeholder-val="{{ false }}">
<div class="d3 pop" style="display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 36px 24px; border-radius: 18px; background: #151515; text-align: center">
<svg width="72" height="72" viewBox="0 0 64 64" fill="none" aria-hidden="true"><rect x="6" y="12" width="40" height="28" rx="4" stroke="#FFE45C" stroke-width="4"></rect><path d="M2 46h48" stroke="#FFE45C" stroke-width="4" stroke-linecap="round"></path><rect x="44" y="26" width="16" height="28" rx="3" fill="#050505" stroke="#8A8A8A" stroke-width="3"></rect><path d="M47 29l10 22" stroke="#FF7A7A" stroke-width="3" stroke-linecap="round"></path></svg>
<div style="font-family: 'VT323', monospace; font-size: 22px; color: #FFE45C">laptop or desktop only</div>
<div style="font-size: 24px; font-weight: 800; color: #FFFFFF">Open the Sprint on a computer</div>
<div style="font-size: 15px; color: #BDBDBD; max-width: 460px; line-height: 1.55">The Sprint test can't be taken on a phone. Log in on a laptop or desktop to start or continue it. Learning and practice still work here.</div>
</div>
</sc-if>
<sc-if value="{{ show.test }}" hint-placeholder-val="{{ false }}">`, 'test phone card');
// Toolbar above the step's media: a full-screen icon button (Watch, Play, Read)
replaceOnce('<sc-if value="{{ recShow }}" hint-placeholder-val="{{ false }}">\n<sc-if value="{{ wt.isVideo }}" hint-placeholder-val="{{ true }}">',
  (a) => a.split('\n')[0] + `
<sc-if value="{{ ss.tools.on }}" hint-placeholder-val="{{ false }}">
<div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
<span style="flex-grow: 1; font-family: 'VT323', monospace; font-size: 19px; color: #8A8A8A">{{ ss.tools.hint }}</span>
<sc-if value="{{ ss.tools.fs }}" hint-placeholder-val="{{ false }}"><button class="k3" onClick="{{ ss.tools.fsGo }}" aria-label="Full screen" title="Full screen" style="flex-shrink: 0; width: 44px; height: 44px; padding: 0; border: 2px solid #333333; border-radius: 12px; background: #151515; color: #FFFFFF; display: flex; align-items: center; justify-content: center"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5"></path><path d="M20 9V4h-5"></path><path d="M4 15v5h5"></path><path d="M20 15v5h-5"></path></svg></button></sc-if>
</div>
</sc-if>
` + a.split('\n')[1], 'step toolbar');

// Watch: a like button pinned on the right side of the video, like a reel
replaceOnce('<video ref="{{ wt.ref }}" controls playsinline preload="metadata" aria-label="{{ wt.title }}" style="display: block; width: {{ wt.vw }}; aspect-ratio: {{ wt.aspect }}; max-height: 78vh; margin: 0 auto; border-radius: 12px; background: #000000"></video>',
  `<sc-if value="{{ ss.pl.on }}" hint-placeholder-val="{{ false }}">
<div class="ss-pl" role="group" aria-label="Videos in this topic"><span class="ss-pl-k">{{ ss.pl.n }} videos</span><sc-for list="{{ ss.pl.items }}" as="pv" hint-placeholder-count="3"><button class="ss-pl-chip" onClick="{{ pv.go }}" aria-pressed="{{ pv.pressed }}">{{ pv.label }}<b>{{ pv.tick }}</b></button></sc-for></div>
</sc-if>
<div id="ss-reel" class="{{ ss.reel.cls }}" style="position: relative; width: 100%; margin: 0 auto">
<div class="ss-reel-box" style="position: relative; width: {{ wt.boxW }}; aspect-ratio: {{ wt.aspect }}; margin: 0 auto; --ar: {{ wt.ar }}">
<video ref="{{ wt.ref }}" onDblClick="{{ ss.like.dbl }}" controls controlslist="nofullscreen" playsinline preload="metadata" aria-label="{{ wt.title }}" style="display: block; width: 100%; height: 100%; object-fit: contain; border-radius: 12px; background: #000000"></video>
<sc-if value="{{ ss.pl.on }}" hint-placeholder-val="{{ false }}"><span class="ss-pl-badge">{{ ss.pl.badge }}</span></sc-if>
<sc-if value="{{ ss.pl.up }}" hint-placeholder-val="{{ false }}"><div class="ss-pl-up" role="status">
<div class="ss-pl-up-card"><span class="ss-pl-up-k">&gt; up next</span><b>{{ ss.pl.upLabel }}</b><span class="ss-pl-up-t">Starts in {{ ss.pl.upLeft }}s</span>
<div class="ss-pl-up-bar"><i style="width: {{ ss.pl.upPct }}"></i></div>
<div style="display: flex; gap: 8px"><button class="ss-pl-btn y" onClick="{{ ss.pl.upNow }}">Play now</button><button class="ss-pl-btn" onClick="{{ ss.pl.upCancel }}">Cancel</button></div></div>
</div></sc-if>
<sc-if value="{{ ss.pl.intro }}" hint-placeholder-val="{{ false }}"><div class="ss-pl-intro" aria-hidden="true"><b>{{ ss.pl.introBig }}</b><span>{{ ss.pl.introSub }}</span></div></sc-if>
<sc-if value="{{ ss.like.on }}" hint-placeholder-val="{{ false }}">
<div style="position: absolute; right: 10px; bottom: 76px; z-index: 2; display: flex; flex-direction: column; align-items: center; gap: 2px">
<button class="ss-like-btn" onClick="{{ ss.like.toggle }}" aria-pressed="{{ ss.like.liked }}" aria-label="{{ ss.like.label }}" title="{{ ss.like.label }}" style="width: 48px; height: 48px; padding: 0; border: 0; background: transparent; display: flex; align-items: center; justify-content: center; cursor: pointer"><svg class="{{ ss.like.cls }}" width="32" height="32" viewBox="0 0 24 24" fill="{{ ss.like.fill }}" stroke="{{ ss.like.stroke }}" stroke-width="1.9" stroke-linejoin="round" aria-hidden="true" style="filter: drop-shadow(0 1px 3px rgba(0,0,0,.55))"><path d="M12 21s-7.6-4.6-9.6-9.4C.9 8 3.1 4.3 6.8 4.3c2.2 0 3.8 1.2 5.2 3.1 1.4-1.9 3-3.1 5.2-3.1 3.7 0 5.9 3.7 4.4 7.3-2 4.8-9.6 9.4-9.6 9.4z"></path></svg></button>
<span style="color: #FFFFFF; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 13px; font-weight: 600; text-shadow: 0 1px 3px rgba(0,0,0,.7)">{{ ss.like.count }}</span>
</div>
<sc-if value="{{ ss.like.burst }}" hint-placeholder-val="{{ false }}"><div aria-hidden="true" style="position: absolute; inset: 0; z-index: 2; display: flex; align-items: center; justify-content: center; pointer-events: none"><svg class="ss-like-burst" width="110" height="110" viewBox="0 0 24 24" fill="#FFFFFF" style="filter: drop-shadow(0 4px 14px rgba(0,0,0,.45))"><path d="M12 21s-7.6-4.6-9.6-9.4C.9 8 3.1 4.3 6.8 4.3c2.2 0 3.8 1.2 5.2 3.1 1.4-1.9 3-3.1 5.2-3.1 3.7 0 5.9 3.7 4.4 7.3-2 4.8-9.6 9.4-9.6 9.4z"></path></svg></div></sc-if>
</sc-if>
<sc-if value="{{ ss.reel.max }}" hint-placeholder-val="{{ false }}"><button onClick="{{ ss.reel.close }}" aria-label="Leave full screen" title="Leave full screen" style="position: absolute; right: 12px; top: 12px; z-index: 3; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%; background: rgba(5,5,5,.6); color: #FFFFFF; font-size: 22px; font-weight: 800; cursor: pointer">✕</button></sc-if>
</div>
</div>`, 'video like button');
// Full screen for the reel takes the video AND its like button (the video's own full screen would hide the heart).
// .ss-reel-max is the in-page fallback for browsers that cannot put a box in full screen (iPhone).
replaceOnce('</head>', `<style>
#ss-reel:fullscreen, #ss-reel.ss-reel-max { display: flex; align-items: center; justify-content: center; width: 100vw !important; height: 100vh; margin: 0 !important; background: #000; }
#ss-reel:-webkit-full-screen { display: flex; align-items: center; justify-content: center; width: 100vw !important; height: 100vh; margin: 0 !important; background: #000; }
#ss-reel.ss-reel-max { position: fixed; inset: 0; z-index: 90; height: 100dvh; }
/* the box is exactly the video's size, so the like button stays at the video's bottom-right in full screen too */
#ss-reel:fullscreen .ss-reel-box { width: min(100vw, calc(100vh * var(--ar))) !important; }
#ss-reel:-webkit-full-screen .ss-reel-box { width: min(100vw, calc(100vh * var(--ar))) !important; }
#ss-reel.ss-reel-max .ss-reel-box { width: min(100vw, calc(100dvh * var(--ar))) !important; }
#ss-reel:fullscreen video, #ss-reel.ss-reel-max video { border-radius: 0 !important; }
#ss-reel:-webkit-full-screen video { border-radius: 0 !important; }
.ss-like-btn:active svg { transform: scale(0.88); }
/* Watch with several videos: the list above the player, a badge on the video, "Up next" and a title card between videos */
.ss-pl { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.ss-pl-k { font-family: 'VT323', monospace; font-size: 20px; color: #FFE45C; margin-right: 6px; }
.ss-pl-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 14px; border: 1px solid #333333; border-radius: 10px; background: transparent; color: #BDBDBD; font-size: 13px; font-weight: 800; cursor: pointer; }
.ss-pl-chip b { color: #9BE58B; }
.ss-pl-chip[aria-pressed="true"] { background: #FFE45C; border-color: #FFE45C; color: #111111; }
.ss-pl-chip[aria-pressed="true"] b { color: #111111; }
/* the badge only in full screen, where the list above the player is out of sight */
.ss-pl-badge { display: none; }
#ss-reel:fullscreen .ss-pl-badge, #ss-reel.ss-reel-max .ss-pl-badge { display: block; }
#ss-reel:-webkit-full-screen .ss-pl-badge { display: block; }
.ss-pl-badge { position: absolute; left: 12px; top: 12px; z-index: 2; padding: 4px 10px; border-radius: 8px; background: rgba(5,5,5,.72); color: #FFE45C; font-family: 'VT323', monospace; font-size: 18px; line-height: 1; letter-spacing: .04em; pointer-events: none; }
.ss-pl-up { position: absolute; inset: 0; z-index: 4; display: flex; align-items: center; justify-content: center; padding: 16px; border-radius: 12px; background: rgba(5,5,5,.78); animation: ssPlIn 200ms cubic-bezier(0.23, 1, 0.32, 1); }
.ss-pl-up-card { width: min(320px, 100%); display: flex; flex-direction: column; gap: 8px; padding: 18px; border: 1px solid #333333; border-radius: 16px; background: #111111; }
.ss-pl-up-k { font-family: 'VT323', monospace; font-size: 20px; color: #FFE45C; line-height: 1; }
.ss-pl-up-card > b { font-size: 20px; font-weight: 800; color: #FFFFFF; }
.ss-pl-up-t { font-size: 13px; color: #BDBDBD; }
.ss-pl-up-bar { height: 4px; border-radius: 2px; background: #262626; overflow: hidden; margin: 4px 0 6px; }
.ss-pl-up-bar i { display: block; height: 100%; background: #FFE45C; transition: width 250ms linear; }
.ss-pl-btn { min-height: 40px; padding: 0 16px; border: 1px solid #333333; border-radius: 10px; background: transparent; color: #FFFFFF; font-size: 14px; font-weight: 800; cursor: pointer; }
.ss-pl-btn.y { background: #FFE45C; border-color: #FFE45C; color: #111111; }
.ss-pl-intro { position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 16px; text-align: center; border-radius: 12px; background: #050505; animation: ssPlIntro 1400ms ease both; pointer-events: none; }
.ss-pl-intro b { font-family: 'Silkscreen', 'Press Start 2P', monospace; font-size: clamp(28px, 6vw, 52px); color: #FFE45C; line-height: 1; }
.ss-pl-intro span { font-size: 14px; font-weight: 700; color: #BDBDBD; }
@keyframes ssPlIn { from { opacity: 0; } }
@keyframes ssPlIntro { 0% { opacity: 0; } 15% { opacity: 1; } 78% { opacity: 1; } 100% { opacity: 0; } }
#ss-reel:fullscreen .ss-pl-up, #ss-reel:fullscreen .ss-pl-intro, #ss-reel.ss-reel-max .ss-pl-up, #ss-reel.ss-reel-max .ss-pl-intro { border-radius: 0; }
@media (prefers-reduced-motion: reduce) { .ss-pl-up, .ss-pl-intro { animation: none; } .ss-pl-up-bar i { transition: none; } }
.ss-nav { display: flex; flex-direction: column; align-items: center; gap: 10px; padding-top: 16px; border-top: 1px solid #1F1F1F; }
.ss-nav-hint { font-size: 13px; font-weight: 700; color: #8A8A8A; text-align: center; }
.ss-nav-row { display: flex; justify-content: center; gap: 14px; width: 100%; }
@media (max-width: 640px) { .ss-nav-row > * { flex: 1; max-width: 220px; } .ss-nav-row button { width: 100%; padding: 0 12px !important; } }
.ss-like-btn svg { transition: transform 120ms cubic-bezier(0.23, 1, 0.32, 1); }
.ss-like-pop { animation: ss-like-pop 420ms cubic-bezier(0.23, 1, 0.32, 1); }
.ss-split-bar:hover span, .ss-split-bar:focus-visible span, .ss-split-bar.on span { background: #FFE45C !important; height: 72px !important; }
.ss-split-bar:focus-visible { outline: none; }
@keyframes ss-like-pop { 0% { transform: scale(0.6); } 45% { transform: scale(1.25); } 100% { transform: scale(1); } }
.ss-like-burst { animation: ss-like-burst 800ms cubic-bezier(0.23, 1, 0.32, 1) forwards; }
@keyframes ss-like-burst { 0% { opacity: 0; transform: scale(0.4); } 18% { opacity: .95; transform: scale(1.1); } 32% { transform: scale(0.95); } 70% { opacity: .95; transform: scale(1); } 100% { opacity: 0; transform: scale(1.05) translateY(-18px); } }
@media (prefers-reduced-motion: reduce) { .ss-like-pop, .ss-like-burst { animation: none; } .ss-like-burst { opacity: 0; } }
/* Home: one column up to 1359 px (right-column cards last), two columns from 1360 px so wide screens are used */
.ss-home-side { display: flex; flex-direction: column; gap: 40px; order: 99; min-width: 0; }
@media (min-width: 1360px) {
  .ss-home-col { display: grid !important; max-width: 1280px !important; grid-template-columns: minmax(0, 1fr) 480px; column-gap: 48px; row-gap: 40px; align-items: start; }
  .ss-home-col > * { grid-column: 1; min-width: 0; }
  .ss-home-col > .ss-home-side { grid-column: 2; grid-row: 1 / span 4; order: 0; }
}
/* top-right icon bar: blended buttons, label appears on hover */
.ss-topbar { display: flex; align-items: center; justify-content: flex-end; gap: 4px; padding: 14px 24px 0 44px; position: relative; z-index: 3; }
.ss-topquote { margin-right: auto; min-width: 0; padding-right: 24px; font-family: 'VT323', monospace; font-size: 19px; line-height: 1.15; color: #8A8A8A; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ss-topquote span { color: #5E5E5E; }
@media (max-width: 1100px) { .ss-opts { grid-template-columns: 1fr !important; } }
.ss-ib { position: relative; width: 42px; height: 42px; border: 0; border-radius: 12px; background: transparent; color: #8A8A8A; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background 140ms ease, color 140ms ease; }
.ss-ib:hover, .ss-ib:focus-visible { background: rgba(255,255,255,.06); color: #FFFFFF; outline: none; }
.ss-ib[data-on="true"] { color: #FFE45C; }
.ss-ib-label { position: absolute; top: 100%; left: 50%; transform: translate(-50%, 2px); margin-top: 4px; padding: 6px 10px; border-radius: 8px; background: #1F1F1F; color: #EDEDED; font-size: 12px; font-weight: 700; white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity 140ms ease, transform 140ms ease; }
.ss-ib:hover .ss-ib-label, .ss-ib:focus-visible .ss-ib-label { opacity: 1; transform: translate(-50%, 0); }
.ss-ib-live { position: absolute; top: 8px; right: 8px; width: 8px; height: 8px; border-radius: 50%; background: #FFE45C; }
.ss-avatar { padding: 0; overflow: visible; }
.ss-avatar img, .ss-avatar-initial { width: 30px; height: 30px; border-radius: 50%; object-fit: cover; display: flex; align-items: center; justify-content: center; background: #050505; border: 2px solid #333333; font-family: 'Silkscreen', monospace; font-size: 12px; color: #BDBDBD; }
.ss-ib[data-on="true"] .ss-avatar-initial, .ss-ib[data-on="true"] img, .ss-avatar:hover img, .ss-avatar:hover .ss-avatar-initial { border-color: #FFE45C; }
.ss-menu-wrap { position: relative; }
.ss-menu { position: absolute; right: 0; top: calc(100% + 8px); min-width: 240px; padding: 8px; border-radius: 16px; background: #171717; border: 1px solid #262626; box-shadow: 0 24px 48px -20px rgba(0,0,0,.9); display: flex; flex-direction: column; gap: 2px; z-index: 50; }
.ss-menu-sep { height: 1px; background: #262626; margin: 6px 4px; }
.ss-menu-head { display: flex; flex-direction: column; gap: 2px; padding: 8px 12px 10px; border-bottom: 1px solid #262626; margin-bottom: 6px; min-width: 0; }
.ss-menu-name { font-size: 14px; font-weight: 800; color: #FFFFFF; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-menu-sub { font-family: 'VT323', monospace; font-size: 17px; color: #8A8A8A; }
.ss-menu-item { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 12px; border: 0; border-radius: 10px; background: transparent; color: #DADADA; font-size: 14px; font-weight: 700; text-align: left; cursor: pointer; }
.ss-menu-item:hover, .ss-menu-item:focus-visible { background: rgba(255,255,255,.06); color: #FFFFFF; outline: none; }
.ss-menu-item svg { width: 18px; height: 18px; color: #8A8A8A; flex-shrink: 0; }
.ss-check { width: 18px; height: 18px; border-radius: 5px; border: 2px solid #3A3A3A; display: flex; align-items: center; justify-content: center; color: transparent; flex-shrink: 0; }
.ss-menu-item[data-on="true"] .ss-check { background: #FFE45C; border-color: #FFE45C; color: #050505; }
.ss-check svg { width: 12px; height: 12px; color: inherit; }
/* Practice: the topic dropdown under the title */
.ss-pt-wrap { align-self: flex-start; max-width: 100%; }
.ss-pt-btn { display: inline-block; max-width: 100%; min-height: 32px; padding: 6px 12px 6px 10px; margin-left: -10px; border: 1px solid transparent; border-radius: 10px; background: transparent; color: #8A8A8A; font-size: 14px; font-weight: 700; line-height: 1.4; cursor: pointer; text-align: left; white-space: nowrap; vertical-align: top; }
@media (max-width: 760px) { .ss-pt-btn { white-space: normal; } }
.ss-pt-t { color: #EDEDED; font-weight: 800; }
.ss-pt-caret { display: inline-block; }
.ss-pt-btn:hover, .ss-pt-btn[aria-expanded="true"] { border-color: #333333; background: #151515; }
.ss-pt-caret { color: #FFE45C; font-size: 12px; transition: transform 160ms ease; }
.ss-pt-btn[aria-expanded="true"] .ss-pt-caret { transform: rotate(180deg); }
.ss-pt-menu { left: -10px; right: auto; min-width: 320px; max-width: min(440px, 90vw); max-height: min(70vh, 520px); overflow-y: auto; }
.ss-pt-item { justify-content: space-between; gap: 14px; }
.ss-pt-n { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-pt-c { flex-shrink: 0; font-family: 'VT323', monospace; font-size: 16px; font-weight: 400; color: #8A8A8A; }
.ss-pt-item[data-on="true"] { background: rgba(255,228,92,.10); color: #FFE45C; }
.ss-pt-item[data-on="true"] .ss-pt-c { color: #FFE45C; }
@media (prefers-reduced-motion: reduce) { .ss-pt-caret { transition: none; } }
/* sidebar topic list */
.ss-topic-list { display: flex; flex-direction: column; gap: 2px; padding: 2px 0 6px; }
.ss-topic-head { padding: 10px 12px 4px; font-family: 'VT323', monospace; font-size: 17px; letter-spacing: .02em; color: #5E5E5E; text-transform: uppercase; }
.ss-topic { display: flex; align-items: center; gap: 10px; min-height: 38px; padding: 0 12px 0 16px; border: 0; border-radius: 10px; font-size: 13px; font-weight: 700; text-align: left; cursor: pointer; }
.ss-topic:hover { filter: brightness(1.25); }
.ss-topic-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.ss-topic-name { flex-grow: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* home topic map */
.ss-map { position: relative; }
.ss-map-road { position: absolute; left: 0; top: 0; }
.ss-map-block { position: absolute; width: 170px; height: 56px; box-sizing: border-box; border-radius: 14px; border: 2px solid; display: flex; align-items: center; gap: 8px; padding: 0 10px; font-size: 12.5px; font-weight: 700; line-height: 1.2; text-align: left; cursor: pointer; transition: transform 160ms ease, filter 160ms ease; }
.ss-map-block:hover { transform: translateY(-2px); filter: brightness(1.12); }
.ss-map-n { flex-shrink: 0; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-family: 'VT323', monospace; font-size: 17px; }
.ss-map-name { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.ss-map-avatar { position: absolute; width: 38px; height: 38px; border-radius: 50%; transform: translate(-50%, -50%); border: 2px solid #FFE45C; background: #050505; box-shadow: 0 0 0 5px rgba(255,228,92,.16), 0 10px 20px -8px rgba(0,0,0,.9); overflow: hidden; display: flex; align-items: center; justify-content: center; z-index: 2; transition: left 800ms cubic-bezier(0.23, 1, 0.32, 1), top 800ms cubic-bezier(0.23, 1, 0.32, 1); }
.ss-map-avatar img { width: 100%; height: 100%; object-fit: cover; }
.ss-map-avatar span { font-family: 'Silkscreen', monospace; font-size: 13px; color: #FFE45C; }
.ss-map-trophy { position: absolute; width: 44px; height: 44px; transform: translate(-50%, -50%); border: 0; border-radius: 50%; background: #151515; color: #FFE45C; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 0 0 2px #262626; transition: box-shadow 160ms ease; }
.ss-map-trophy:hover { box-shadow: 0 0 0 2px #FFE45C, 0 0 18px -4px rgba(255,228,92,.6); }
.ss-map-trophy svg { width: 22px; height: 22px; }
@media (prefers-reduced-motion: reduce) { .ss-map-avatar { transition: none; } }
/* Learn: Watch / Play / Read as a tab strip that sits on the content below it */
.ss-steps { display: flex; gap: 2px; border-bottom: 1px solid #262626; margin-bottom: -6px; }
.ss-step { position: relative; display: flex; align-items: center; gap: 8px; min-height: 42px; padding: 0 16px; border: 0; background: transparent; color: #8A8A8A; font-size: 15px; font-weight: 800; cursor: pointer; transition: color 160ms ease; }
.ss-step:hover { color: #FFFFFF; }
.ss-step::after { content: ""; position: absolute; left: 10px; right: 10px; bottom: -1px; height: 2px; border-radius: 2px; background: transparent; transition: background 160ms ease; }
.ss-step[aria-selected="true"] { color: #FFE45C; }
.ss-step[aria-selected="true"]::after { background: #FFE45C; }
.ss-step-mark { width: 20px; height: 20px; border-radius: 50%; background: #262626; color: #8A8A8A; font-size: 11px; display: flex; align-items: center; justify-content: center; }
.ss-step[aria-selected="true"] .ss-step-mark, .ss-step[data-done="true"] .ss-step-mark { background: #FFE45C; color: #050505; }
.ss-step[data-done="true"] { color: #DADADA; }
/* Practice "Hiring" tab: question on the left, the companies and jobs it was asked for on the right */
.ss-hq2 { display: flex; flex-direction: column; gap: 26px; }
.ss-hq2-top { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; font-size: 13px; color: #7D7D7D; }
.ss-hq2-pos { white-space: nowrap; }
.ss-hq2-pos b { color: #FFE45C; }
.ss-hq2-bar { flex: 1; min-width: 120px; height: 4px; border-radius: 2px; background: #1C1C1C; overflow: hidden; }
.ss-hq2-bar i { display: block; height: 100%; background: #FFE45C; transition: width 300ms cubic-bezier(0.23, 1, 0.32, 1); }
.ss-hq2-tabs { display: flex; gap: 4px; }
.ss-hq2-tabs button { border: 0; background: none; color: #7D7D7D; font-weight: 700; font-size: 13px; padding: 9px 12px; border-radius: 9px; white-space: nowrap; }
.ss-hq2-tabs button[aria-pressed="true"] { background: #FFE45C; color: #111111; }
.ss-hq2-grid { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 56px; }
@media (max-width: 1100px) { .ss-hq2-grid { grid-template-columns: 1fr; gap: 32px; } }
.ss-hq2-meta { display: flex; gap: 10px; align-items: center; font-size: 12px; color: #7D7D7D; font-weight: 700; letter-spacing: .08em; margin-bottom: 14px; }
.ss-hq2-lvl { border: 1px solid; padding: 3px 10px; border-radius: 999px; letter-spacing: 0; }
.ss-hq2-q { font-size: 28px; font-weight: 800; color: #FFFFFF; line-height: 1.35; margin-bottom: 26px; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 700px) { .ss-hq2-q { font-size: 21px; } }
.ss-hq2-code { margin: -8px 0 22px; padding: 16px 18px; background: #050505; border: 1px solid #262626; border-radius: 12px; font-family: 'JetBrains Mono', monospace; font-size: 14px; line-height: 1.65; color: #FFFFFF; white-space: pre-wrap; overflow-wrap: anywhere; font-variant-ligatures: none; }
.ss-hq2-opt { width: 100%; display: flex; gap: 16px; align-items: flex-start; text-align: left; background: none; border: 1px solid #262626; border-radius: 12px; padding: 16px 18px; margin-bottom: 10px; color: #FFFFFF; font-size: 15.5px; line-height: 1.5; font-weight: 600; transition: border-color 150ms ease, background-color 150ms ease; }
@media (hover: hover) { .ss-hq2-opt:hover { border-color: #444444; } }
.ss-hq2-opt b { flex: none; width: 28px; height: 28px; border-radius: 7px; background: #1A1A1A; color: #FFE45C; display: flex; align-items: center; justify-content: center; font-size: 13px; }
.ss-hq2-opt span { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-variant-ligatures: none; }
.ss-hq2-opt[data-st="sel"] { border-color: #FFE45C; background: rgba(255,228,92,.06); }
.ss-hq2-opt[data-st="sel"] b { background: #FFE45C; color: #111111; }
.ss-hq2-opt[data-st="ok"] { border-color: #9BE58B; background: rgba(155,229,139,.08); }
.ss-hq2-opt[data-st="ok"] b { background: #9BE58B; color: #111111; }
.ss-hq2-opt[data-st="bad"] { border-color: #FF7A7A; background: rgba(255,122,122,.07); }
.ss-hq2-opt[data-st="bad"] b { background: #FF7A7A; color: #111111; }
.ss-hq2-fb { font-size: 14px; line-height: 1.6; color: #BDBDBD; margin-top: 6px; font-variant-ligatures: none; }
.ss-hq2-iq { margin-top: 8px; font-size: 12.5px; line-height: 1.5; color: #7D7D7D; }
.ss-hq2-iq span { color: #BDBDBD; }
.ss-hq2-act { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 22px; }
.ss-hq2-btn { border: 1px solid #333333; background: none; color: #FFFFFF; font-weight: 800; font-size: 14px; padding: 12px 20px; border-radius: 11px; white-space: nowrap; }
.ss-hq2-btn[aria-disabled="true"] { opacity: .3; cursor: default; }
.ss-hq2-btn.y { background: #FFE45C; border-color: #FFE45C; color: #111111; }
.ss-hq2-asked h3 { margin: 0 0 6px; font-size: 12px; letter-spacing: .14em; color: #FFE45C; font-weight: 800; }
.ss-hq2-asked p { margin: 0 0 18px; font-size: 14px; color: #BDBDBD; line-height: 1.5; }
.ss-hq2-asked p b { color: #FFFFFF; }
.ss-hq2-co { padding: 16px 0; border-top: 1px solid #222222; }
.ss-hq2-co .n { font-size: 17px; font-weight: 800; color: #FFFFFF; overflow-wrap: anywhere; }
.ss-hq2-co .r { font-size: 14px; color: #FFE45C; margin-top: 4px; font-weight: 700; overflow-wrap: anywhere; }
.ss-hq2-co .d { font-size: 12.5px; color: #7D7D7D; margin-top: 6px; }
@media (prefers-reduced-motion: reduce) { .ss-hq2-bar i, .ss-hq2-opt { transition: none; } }
/* Profile page: photo, streak, medals (values: portal-bridge.js ssProfileVals) */
.ss-medal-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.ss-medal-card { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid; border-radius: 14px; background: #151515; min-width: 0; }
.ss-medal-icon { flex-shrink: 0; width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
.ss-medal-icon i { display: block; width: 24px; height: 24px; background: currentColor; -webkit-mask: var(--mi) center / 24px 24px no-repeat; mask: var(--mi) center / 24px 24px no-repeat; }
.ss-mi-first-lap { --mi: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M5%2021V4%22%2F%3E%3Cpath%20d%3D%22M5%204h12l-2%204%202%204H5%22%2F%3E%3C%2Fsvg%3E"); }
.ss-mi-full-circuit { --mi: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M21%2012a9%209%200%201%201-2.6-6.4%22%2F%3E%3Cpath%20d%3D%22M21%204v5h-5%22%2F%3E%3C%2Fsvg%3E"); }
.ss-mi-pace-keeper { --mi: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M12%203c1.5%203%205%205.5%205%2010a5%205%200%200%201-10%200c0-2.2%201.2-3.6%202.4-5%20.3%202%201.3%203%202.6%203.2C12.6%209%2011.4%206%2012%203z%22%2F%3E%3C%2Fsvg%3E"); }
.ss-mi-finisher { --mi: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M5%2021V4%22%2F%3E%3Cpath%20d%3D%22M5%204h13l-1.5%204L18%2012H5%22%2F%3E%3Cpath%20d%3D%22M9%204v8M13%204v8M5%208h13%22%2F%3E%3C%2Fsvg%3E"); }
.ss-mi-podium { --mi: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M3%2021h18%22%2F%3E%3Cpath%20d%3D%22M4%2021v-7h5v7%22%2F%3E%3Cpath%20d%3D%22M9.5%2021V9h5v12%22%2F%3E%3Cpath%20d%3D%22M15%2021v-5h5v5%22%2F%3E%3C%2Fsvg%3E"); }
.ss-mi-hat-trick { --mi: url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Ccircle%20cx%3D%226%22%20cy%3D%2215%22%20r%3D%223%22%2F%3E%3Ccircle%20cx%3D%2212%22%20cy%3D%229%22%20r%3D%223%22%2F%3E%3Ccircle%20cx%3D%2218%22%20cy%3D%2215%22%20r%3D%223%22%2F%3E%3C%2Fsvg%3E"); }
@media (max-width: 1360px) { .ss-medal-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
</head>`, 'reel full screen styles');

// Coding practice honeypots: hidden trap line and watermark in the question text, invisible bot field by Submit
replaceOnce('<div style="font-size: 15px; line-height: 1.6; color: #DADADA; white-space: pre-wrap">{{ ws.text }}</div>',
  '<div data-ssq="{{ ss.hp.qid }}" style="font-size: 15px; line-height: 1.6; color: #DADADA; white-space: pre-wrap"><span aria-hidden="true" style="font-size: 0; line-height: 0; color: transparent">{{ ss.hp.trap }}</span>{{ ss.hp.a }}<span aria-hidden="true" style="font-size: 0; line-height: 0; color: transparent">{{ ss.hp.trap }}</span>{{ ss.hp.b }}<span aria-hidden="true" style="font-size: 0; line-height: 0; color: transparent">{{ ss.hp.trap }}</span></div>', 'question trap');
// the Practice tab's coding card shows the question text too: same hidden line (start, middle and end)
replaceOnce('<div style="font-size: 16px; line-height: 1.6; color: #BDBDBD; white-space: pre-wrap; max-height: 260px; overflow-y: auto">{{ pq.ckText }}</div>',
  '<div data-ssq="{{ ss.hpc.qid }}" style="font-size: 16px; line-height: 1.6; color: #BDBDBD; white-space: pre-wrap; max-height: 260px; overflow-y: auto"><span aria-hidden="true" style="font-size: 0; line-height: 0; color: transparent">{{ ss.hpc.trap }}</span>{{ ss.hpc.a }}<span aria-hidden="true" style="font-size: 0; line-height: 0; color: transparent">{{ ss.hpc.trap }}</span>{{ ss.hpc.b }}<span aria-hidden="true" style="font-size: 0; line-height: 0; color: transparent">{{ ss.hpc.trap }}</span></div>', 'practice card trap');
replaceOnce('<sc-if value="{{ ws.canSubmit }}" hint-placeholder-val="{{ true }}"><button class="b3" onClick="{{ ws.submit }}"',
  '<input id="ss-hp-field" type="text" name="website" tabindex="-1" aria-hidden="true" autocomplete="off" style="position: absolute; left: -10000px; top: auto; width: 1px; height: 1px; opacity: 0">' +
  '<sc-if value="{{ ws.canSubmit }}" hint-placeholder-val="{{ true }}"><button class="b3" onClick="{{ ws.submit }}"', 'bot field');
replaceOnce("return h('iframe', { src: props.href, title: 'Class slides', allowfullscreen: true, loading: 'lazy',",
  "return h('iframe', { id: 'ss-embed', src: props.href, title: 'Class slides', allowfullscreen: true, allow: 'fullscreen', loading: 'lazy',", 'embed id');

// ---------- 4f. Feedback: one required question on AI use (Sprint/practice), before the comment box
replaceOnce('<span style="font-size: 14px; color: #8A8A8A">Both questions are required.</span>', '<span style="font-size: 14px; color: #8A8A8A">{{ ss.ai.req }}</span>', 'feedback required note');
replaceOnce('<div style="display: flex; flex-direction: column; gap: 8px">\n<label for="fb-text"', `<sc-if value="{{ ss.ai.on }}" hint-placeholder-val="{{ false }}">
<div style="display: flex; flex-direction: column; gap: 8px">
<span id="ss-ai-use" style="font-size: 15px; font-weight: 800; color: #FFFFFF">To what extent did you use AI tools while completing the Sprint/practice questions? <span style="color: #FF7A7A">*</span></span>
<div role="radiogroup" aria-labelledby="ss-ai-use" style="display: flex; flex-direction: column; gap: 6px">
<sc-for list="{{ ss.ai.use.opts }}" as="aou" hint-placeholder-count="5">
<button role="radio" onClick="{{ aou.pick }}" aria-checked="{{ aou.on }}" style="display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 12px; border: 2px solid {{ aou.ring }}; border-radius: 10px; background: {{ aou.bg }}; color: {{ aou.fg }}; font-size: 14px; font-weight: 700; text-align: left; cursor: pointer"><span aria-hidden="true" style="width: 14px; height: 14px; flex-shrink: 0; border-radius: 50%; border: 2px solid {{ aou.ring }}; background: {{ aou.dot }}"></span><span>{{ aou.t }}</span></button>
</sc-for>
</div>
<sc-if value="{{ ss.ai.use.err }}" hint-placeholder-val="{{ false }}"><span style="font-size: 13px; font-weight: 700; color: #FF7A7A">Choose one option.</span></sc-if>
</div>
</sc-if>
<div style="display: flex; flex-direction: column; gap: 8px">
<label for="fb-text"`, 'feedback AI questions');
replaceOnce('<div class="d3 pop" style="width: 560px; max-width: 100%; box-sizing: border-box; padding: 28px 30px;',
  '<div class="d3 pop" style="width: 560px; max-width: 100%; max-height: calc(100vh - 48px); overflow-y: auto; box-sizing: border-box; padding: 28px 30px;', 'feedback modal scroll');

// ---------- 4g. Code editor: drag the bar between the problem and the editor to resize them (keyboard: arrows; double-click resets)
replaceOnce('<div style="flex-grow: 1; min-height: 0; display: flex; gap: 10px">\n<!-- left: problem -->',
  '<div id="ss-split" style="flex-grow: 1; min-height: 0; display: flex; --ss-left: {{ ss.split.w }}">\n<!-- left: problem -->', 'split container');
replaceOnce('<section class="d3" style="flex: 0 0 42%; min-width: 0; display: flex; flex-direction: column; border-radius: 14px; background: #151515; overflow: hidden">',
  '<section class="d3" style="flex: 0 0 var(--ss-left, 42%); min-width: 0; display: flex; flex-direction: column; border-radius: 14px; background: #151515; overflow: hidden">', 'split left panel');
replaceOnce('</section>\n\n<!-- right: editor + console -->',
  `</section>
<div class="ss-split-bar" role="separator" aria-orientation="vertical" aria-label="Resize the problem and the code editor" aria-valuemin="20" aria-valuemax="75" aria-valuenow="{{ ss.split.n }}" tabindex="0" title="Drag to resize · double-click to reset" onPointerDown="{{ ss.split.down }}" onKeyDown="{{ ss.split.key }}" onDblClick="{{ ss.split.reset }}" style="flex: 0 0 12px; align-self: stretch; cursor: col-resize; touch-action: none; display: flex; align-items: center; justify-content: center"><span style="width: 4px; height: 48px; border-radius: 2px; background: #333333; transition: background 150ms ease, height 150ms ease"></span></div>

<!-- right: editor + console -->`, 'split bar');

// ---------- 4h. Practice: Web Application Development as a third course (built-in WAD quizzes + admin-added questions)
replaceOnce("const pcNames = [['pf', 'Programming Foundations'], ['genai', 'Intro to GenAI']];",
  "const pcNames = [['pf', 'Programming Foundations'], ['genai', 'Intro to GenAI'], ['wad', 'Web Application Development']];", 'practice WAD course');

// ---------- 5. Sprint date/time/duration text follows Admin → Sprint settings (the HTML had them fixed)
replaceOnce('<div style="font-size: 15px; color: #8A8A8A">Sat, 3 Oct · 11:00 – 11:30 AM IST</div>',
  '<div style="font-size: 15px; color: #8A8A8A">{{ ss.when.line }}</div>', 'home date line');
replaceOnce('Sat, 3 Oct · 11:00 – 11:30 AM IST · 30 minutes · one attempt', '{{ ss.when.line }} · {{ ss.when.dur }} · one attempt', 'locked date line');
replaceOnce('30 minutes. Closes at 11:30 AM. {{ t.readyNote }}', '{{ ss.when.durCap }}. Closes at {{ ss.when.close }}. {{ t.readyNote }}', 'ready line');

fs.mkdirSync(path.join(ROOT, 'public'), { recursive: true });
const out = path.join(ROOT, 'public', 'portal.html');
fs.writeFileSync(out, html);
if (html.includes(arrText)) throw new Error('Sprint answers are still in the page.');
console.log('Portal  →', path.relative(ROOT, out), `(${(html.length / 1024 / 1024).toFixed(2)} MB)`);
