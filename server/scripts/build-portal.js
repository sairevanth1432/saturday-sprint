// Builds public/portal.html from the single-file portal export and wires it to this server.
//
//   npm run build:portal                      uses the newest ../saturday_sprint_portal*.html
//   npm run build:portal -- "path/to/file.html"
//
// What it does (re-run it whenever the portal HTML is updated):
//   1. Extracts the Sprint test (questions + answers + hidden tests) into data/sprint-test.json (server only)
//      and removes it from the page, so answers never reach the browser.
//   2. Adds the Leaderboard tab, a Home leaderboard card, the post-test leaderboard, and the user/logout block.
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
    .filter((q) => q.sess && ['pf', 'genai'].includes(q.course)); // the courses and sessions the Practice tab shows
  const code = (classArray('ccbpCoding') || []).map((c) => ({ id: c.id, topic: c.topic || '', title: c.title || c.id }));
  fs.writeFileSync(path.join(ROOT, 'generated', 'practice.json'), JSON.stringify({ quiz, code }));
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

const NAV_BOARD = `<button class="k3" onClick="{{ nav.board.go }}" aria-label="Leaderboard" title="Leaderboard" style="display: flex; align-items: center; justify-content: {{ side.jc }}; gap: 12px; min-height: 48px; padding: 0 14px; border: 0; border-radius: 12px; background: {{ nav.board.bg }}; color: {{ nav.board.fg }}; font-size: 17px; font-weight: 700; text-align: left">
${ICON_BOARD}
<sc-if value="{{ side.full }}" hint-placeholder-val="{{ true }}"><span style="flex-grow: 1">Leaderboard</span></sc-if>
</button>`;

const NAV_USER = `<div style="margin-top: auto; display: flex; flex-direction: column; gap: 10px">
<sc-if value="{{ side.full }}" hint-placeholder-val="{{ true }}">
<div style="display: flex; align-items: center; gap: 10px; padding: 0 4px; min-width: 0">
<sc-if value="{{ ss.user.hasPhoto }}" hint-placeholder-val="{{ false }}">
<button onClick="{{ ss.user.changePhoto }}" aria-label="Change your photo" title="Change your photo" style="flex-shrink: 0; width: 44px; height: 44px; padding: 0; border: 2px solid #333333; border-radius: 12px; overflow: hidden; background: #050505; cursor: pointer"><img src="{{ ss.user.photo }}" alt="" style="display: block; width: 100%; height: 100%; object-fit: cover"></button>
</sc-if>
<div style="display: flex; flex-direction: column; gap: 2px; min-width: 0">
<span style="font-size: 15px; font-weight: 800; color: #FFFFFF; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" title="{{ ss.user.name }}">{{ ss.user.name }}</span>
<span style="font-family: 'VT323', monospace; font-size: 18px; color: #8A8A8A; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ ss.user.sub }}</span>
</div>
</div>
</sc-if>
<sc-if value="{{ ss.user.isAdmin }}" hint-placeholder-val="{{ false }}">
<button class="k3" onClick="{{ ss.toAdmin }}" aria-label="Admin console" title="Admin console" style="display: flex; align-items: center; justify-content: {{ side.jc }}; gap: 10px; min-height: 44px; padding: 0 14px; border: 2px solid #FFE45C; border-radius: 12px; background: transparent; color: #FFE45C; font-size: 15px; font-weight: 700"><svg style="flex-shrink: 0" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"></path></svg><sc-if value="{{ side.full }}" hint-placeholder-val="{{ true }}"><span>Admin console</span></sc-if></button>
</sc-if>
<button class="k3" onClick="{{ ss.help }}" aria-label="Help: how the Sprint works" title="Help: how the Sprint works" style="display: flex; align-items: center; justify-content: {{ side.jc }}; gap: 10px; min-height: 44px; padding: 0 14px; border: 2px solid #333333; border-radius: 12px; background: transparent; color: #FFE45C; font-size: 15px; font-weight: 700">
${ICON_HELP}
<sc-if value="{{ side.full }}" hint-placeholder-val="{{ true }}"><span>Help &amp; guide</span></sc-if>
</button>
<button class="k3" onClick="{{ ss.logout }}" aria-label="Log out" title="Log out" style="display: flex; align-items: center; justify-content: {{ side.jc }}; gap: 10px; min-height: 44px; padding: 0 14px; border: 2px solid #333333; border-radius: 12px; background: transparent; color: #BDBDBD; font-size: 15px; font-weight: 700">
${ICON_OUT}
<sc-if value="{{ side.full }}" hint-placeholder-val="{{ true }}"><span>Log out</span></sc-if>
</button>
</div>`;

replaceOnce('\n</div>\n\n</nav>', `\n${NAV_BOARD}\n</div>\n\n${NAV_USER}\n</nav>`, 'sidebar');

const BOARD_ROW = (list, as) => `<sc-for list="{{ ${list} }}" as="${as}" hint-placeholder-count="5">
<div style="display: grid; grid-template-columns: 76px minmax(0, 1fr) 150px 130px 92px; align-items: center; gap: 12px; min-height: 56px; padding: 6px 16px; border-radius: 14px; border: 2px solid {{ ${as}.ring }}; background: {{ ${as}.bg }}">
<span style="justify-self: start; min-width: 44px; height: 34px; padding: 0 8px; box-sizing: border-box; border-radius: 10px; border: 2px solid {{ ${as}.rankRing }}; background: {{ ${as}.rankBg }}; color: {{ ${as}.rankFg }}; font-family: 'VT323', monospace; font-size: 22px; display: flex; align-items: center; justify-content: center">{{ ${as}.rank }}</span>
<span style="display: flex; flex-direction: column; min-width: 0">
<span style="font-size: 16px; font-weight: 800; color: #FFFFFF; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ ${as}.name }} <span style="color: #FFE45C">{{ ${as}.youTag }}</span></span>
<span style="font-family: 'VT323', monospace; font-size: 17px; color: #8A8A8A">{{ ${as}.id }}</span>
</span>
<span style="font-size: 14px; color: #BDBDBD; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ ${as}.batch }}</span>
<span style="font-family: 'VT323', monospace; font-size: 24px; color: #FFE45C; text-align: right">{{ ${as}.score }}</span>
<span style="font-family: 'VT323', monospace; font-size: 22px; color: #EDEDED; text-align: right">{{ ${as}.time }}</span>
</div>
</sc-for>`;

const BOARD_HEAD = `<div style="display: grid; grid-template-columns: 76px minmax(0, 1fr) 150px 130px 92px; gap: 12px; padding: 0 18px; font-size: 13px; font-weight: 800; color: #8A8A8A">
<span>Rank</span><span>Student</span><span>Batch</span><span style="text-align: right">Score</span><span style="text-align: right">Time</span>
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

<sc-if value="{{ lb.loading }}" hint-placeholder-val="{{ false }}"><div style="font-family: 'VT323', monospace; font-size: 22px; color: #8A8A8A">loading…</div></sc-if>
<sc-if value="{{ lb.empty }}" hint-placeholder-val="{{ false }}">
<div class="well" style="background: #050505; border-radius: 22px; padding: 36px; display: flex; flex-direction: column; gap: 8px">
<div style="font-family: 'VT323', monospace; font-size: 20px; color: #FFE45C">0 rows</div>
<div style="font-size: 20px; font-weight: 800">No results yet.</div>
<div style="font-size: 15px; color: #BDBDBD">{{ lb.emptyNote }}</div>
</div>
</sc-if>
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

const HOME_CARD = `<div class="d3" style="background: #151515; border-radius: 22px; padding: 22px 24px; display: flex; flex-direction: column; gap: 14px">
<div style="display: flex; align-items: center; gap: 14px">
<div style="flex-grow: 1; display: flex; flex-direction: column; gap: 4px">
<span style="font-size: 13px; font-weight: 800; color: #FFE45C">Leaderboard · {{ lb.participants }} on the board</span>
<span style="font-size: 18px; font-weight: 800; color: #FFFFFF">{{ lb.homeLine }}</span>
</div>
<button class="k3" onClick="{{ nav.board.go }}" style="flex-shrink: 0; min-height: 44px; padding: 0 16px; border: 2px solid #333333; border-radius: 12px; background: transparent; color: #FFFFFF; font-size: 15px; font-weight: 700">Full leaderboard →</button>
</div>
<sc-if value="{{ lb.hasRows }}" hint-placeholder-val="{{ false }}">
<div style="display: flex; flex-direction: column; gap: 6px">
<sc-for list="{{ lb.top5 }}" as="hr" hint-placeholder-count="5">
<div style="display: grid; grid-template-columns: 52px minmax(0, 1fr) 110px 70px; align-items: center; gap: 10px; min-height: 40px; padding: 2px 12px; border-radius: 10px; border: 2px solid {{ hr.ring }}; background: {{ hr.bg }}">
<span style="font-family: 'VT323', monospace; font-size: 21px; color: {{ hr.rankText }}">{{ hr.rank }}</span>
<span style="font-size: 14px; font-weight: 700; color: #FFFFFF; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ hr.name }} <span style="color: #FFE45C">{{ hr.youTag }}</span></span>
<span style="font-family: 'VT323', monospace; font-size: 21px; color: #FFE45C; text-align: right">{{ hr.score }}</span>
<span style="font-family: 'VT323', monospace; font-size: 20px; color: #BDBDBD; text-align: right">{{ hr.time }}</span>
</div>
</sc-for>
</div>
</sc-if>
</div>
`;
replaceOnce('</div>\n</sc-if>\n\n<!-- ============ LEARN ============ -->', (a) => HOME_CARD + a, 'home leaderboard card');

const DONE_BOARD = `
<sc-if value="{{ ss.submit.failed }}" hint-placeholder-val="{{ false }}">
<div style="display: flex; align-items: center; gap: 14px; padding: 14px 18px; border-radius: 14px; border: 2px solid #FF7A7A; background: rgba(255,122,122,.08)">
<span style="flex-grow: 1; font-size: 15px; font-weight: 700; color: #FF7A7A">{{ ss.submit.error }}</span>
<button class="b3" onClick="{{ ss.submit.retry }}" style="flex-shrink: 0; min-height: 44px; padding: 0 18px; border: 0; border-radius: 12px; background: #FFE45C; color: #050505; font-size: 15px; font-weight: 800">Try again</button>
</div>
</sc-if>
<sc-if value="{{ ss.submit.pending }}" hint-placeholder-val="{{ false }}">
<div style="font-family: 'VT323', monospace; font-size: 22px; color: #FFE45C" class="blink">grading on the server…</div>
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
replaceOnce('<sc-if value="{{ wt.isSlides }}" hint-placeholder-val="{{ false }}">\n<a data-embed="slides"',
  `<sc-if value="{{ ss.fs.on }}" hint-placeholder-val="{{ false }}">
<div style="display: flex; align-items: center; gap: 12px">
<span style="flex-grow: 1; font-family: 'VT323', monospace; font-size: 19px; color: #8A8A8A">{{ ss.fs.hint }}</span>
<button class="k3" onClick="{{ ss.fs.go }}" aria-label="{{ ss.fs.label }}" title="{{ ss.fs.label }}" style="flex-shrink: 0; display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 16px; border: 2px solid #FFE45C; border-radius: 12px; background: transparent; color: #FFE45C; font-size: 14px; font-weight: 800"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5"></path><path d="M20 9V4h-5"></path><path d="M4 15v5h5"></path><path d="M20 15v5h-5"></path></svg><span>{{ ss.fs.label }}</span></button>
</div>
</sc-if>
<sc-if value="{{ wt.isSlides }}" hint-placeholder-val="{{ false }}">
<a data-embed="slides"`, 'full screen button');
replaceOnce("return h('iframe', { src: props.href, title: 'Class slides', allowfullscreen: true, loading: 'lazy',",
  "return h('iframe', { id: 'ss-embed', src: props.href, title: 'Class slides', allowfullscreen: true, allow: 'fullscreen', loading: 'lazy',", 'embed id');

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
