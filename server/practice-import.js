// Import practice questions from the content JSON files (Admin → Practice questions → Import JSON).
// Format (one file per session): { track, course, session, mcq_practice: [{ questions: [...] }], coding_practice: [{ questions: [...] }] }
//   MCQ:    { question_id, question_type, question_content, ...options / correct answer / code / explanation when present }
//   coding: { question_id, question_type: "CODING", question_short_text, question_difficulty, question_content, ...test cases when present }
// Field names for options, answers, code and test cases vary between exports, so several common ones are accepted.
// Questions that are complete go live; incomplete ones can come in as drafts (hidden until finished in the editor).
// Re-importing the same file updates questions by question_id instead of adding duplicates.

const TEXT_TYPES = new Set(['TEXTUAL', 'CODE_ANALYSIS_TEXTUAL', 'FIB_CODING', 'FIB_HTML_CODING']);

export function courseOf(track, course) {
  const t = String(track || '') + ' ' + String(course || '');
  if (/programming|python|computer programming/i.test(t)) return 'pf';
  if (/gen\s*ai|generative/i.test(t)) return 'genai';
  if (/\bwad\b|web application|html|css/i.test(t)) return 'wad';
  return '';
}
// "Building … | Part - 2" → "Building … | Part 2"; em/en dashes → " | " (the portal uses pipes, not dashes)
export const topicOf = (session) => String(session || '').replace(/\s*[—–]\s*/g, ' | ').replace(/Part\s*-\s*(\d)/gi, 'Part $1').replace(/\s+/g, ' ').trim();

const ENT = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
// HTML / markdown question text → plain text the portal shows (it renders text, not HTML).
export function plain(s) {
  return String(s == null ? '' : s).replace(/\r\n?/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '').replace(/&(lt|gt|amp|quot|#39|nbsp);/g, (m) => ENT[m])
    .replace(/^\s*-{3,}\s*$/gm, '').replace(/^#{1,6}\s*/gm, '').replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/!\[[^\]]*\]\(([^)]+)\)/g, '[image: $1]')
    .replace(/\n{3,}/g, '\n\n').trim();
}
// The first ``` code block, taken out of an MCQ question (shown separately as code).
function splitCode(s) {
  const m = /```[a-zA-Z]*\n?([\s\S]*?)```/.exec(String(s || ''));
  return m ? { text: String(s).replace(m[0], '').trim(), code: m[1].replace(/\s+$/, '') } : { text: String(s || ''), code: '' };
}
const first = (o, keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return undefined; };
const optText = (o) => (typeof o === 'string' || typeof o === 'number' ? String(o) : plain(first(o, ['content', 'text', 'option', 'value', 'option_content', 'option_text', 'label']) ?? ''));
const optId = (o) => (o && typeof o === 'object' ? first(o, ['option_id', 'id', 'key']) : undefined);
const isTrue = (v) => v === true || v === 1 || v === 'true' || v === 'TRUE' || v === 'True';

function readMcq(q) {
  const raw = first(q, ['options', 'choices', 'question_options', 'answer_options', 'options_json']);
  let opts = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return raw.split(' | '); } })() : raw;
  opts = Array.isArray(opts) ? opts : [];
  const o = opts.map(optText).map((t) => t.trim());
  // correct answer: a flag on the option, an index, an option id, or the option text (single or a list)
  let c = opts.map((x, i) => (x && typeof x === 'object' && isTrue(first(x, ['is_correct', 'correct', 'isCorrect', 'is_answer']))) ? i : -1).filter((i) => i >= 0);
  if (!c.length) {
    let ans = first(q, ['correct_answer', 'correct_answers', 'answer', 'answers', 'correct_option', 'correct_options', 'correct_option_index', 'answer_index']);
    if (typeof ans === 'string') { try { ans = JSON.parse(ans); } catch { /* plain text */ } }
    const list = Array.isArray(ans) ? ans : ans === undefined ? [] : [ans];
    for (const a of list) {
      let i = -1;
      if (typeof a === 'number' && Number.isInteger(a) && a >= 0 && a < o.length) i = a;
      else if (a && typeof a === 'object') { const id = optId(a), t = optText(a); i = opts.findIndex((x) => id !== undefined && optId(x) === id); if (i < 0) i = o.indexOf(t.trim()); }
      else { const s = String(a).trim(); i = opts.findIndex((x) => optId(x) !== undefined && String(optId(x)) === s); if (i < 0) i = o.findIndex((t) => t === s); if (i < 0 && /^[A-F]$/i.test(s)) i = s.toUpperCase().charCodeAt(0) - 65; }
      if (i >= 0 && !c.includes(i)) c.push(i);
    }
  }
  const sp = splitCode(first(q, ['question_content', 'content', 'question', 'q']));
  const code = String(first(q, ['code', 'code_snippet', 'question_code', 'code_content']) ?? (q.code_details && q.code_details.code) ?? sp.code ?? '').replace(/\r\n?/g, '\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
  return { q: plain(sp.text), code, o, c, why: plain(first(q, ['explanation', 'solution', 'answer_explanation', 'why']) ?? '') };
}

function readTests(q) {
  const raw = first(q, ['test_cases', 'testcases', 'tests', 'test_case_details', 'sample_test_cases']);
  let arr = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : raw;
  arr = Array.isArray(arr) ? arr : [];
  const tests = arr.map((t) => Array.isArray(t) ? [String(t[0] ?? ''), String(t[1] ?? ''), !!t[2]]
    : [String(first(t, ['input', 'stdin', 'input_data']) ?? ''), String(first(t, ['output', 'expected_output', 'expected', 'stdout', 'output_data']) ?? ''),
      isTrue(first(t, ['is_hidden', 'hidden', 'isHidden'])) || /hidden/i.test(String(first(t, ['test_case_type', 'type']) ?? ''))])
    .map((t) => [t[0].replace(/\r\n?/g, '\n'), t[1].replace(/\r\n?/g, '\n'), t[2]]).filter((t) => t[1].trim() !== '');
  if (tests.length && tests.every((t) => t[2])) tests[0][2] = false; // at least one visible sample
  return tests;
}

// files: [{ name, json }] (json = parsed object or text). Returns every question with what is missing.
export function parseImport(files) {
  const items = [], problems = [];
  for (const f of files || []) {
    let d = f.json;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { problems.push({ file: f.name, message: 'Not valid JSON: ' + e.message }); continue; } }
    if (!d || typeof d !== 'object' || (!Array.isArray(d.mcq_practice) && !Array.isArray(d.coding_practice))) { problems.push({ file: f.name, message: 'No mcq_practice or coding_practice in this file.' }); continue; }
    const course = courseOf(d.track, d.course), topic = topicOf(d.session);
    if (!course) problems.push({ file: f.name, message: 'Unknown course "' + (d.track || d.course || '') + '" (expected Programming Foundations, GenAI or WAD).' });
    if (!topic) problems.push({ file: f.name, message: 'No session (topic) name.' });
    for (const set of d.mcq_practice || []) for (const q of set.questions || []) {
      const type = String(q.question_type || 'MULTIPLE_CHOICE').toUpperCase(), srcId = String(q.question_id || '');
      const it = { file: f.name, srcId, kind: 'mcq', course, topic, type, issues: [], skip: '' };
      if (TEXT_TYPES.has(type)) { it.skip = 'Written-answer question: Practice has multiple choice only.'; it.data = { q: plain(q.question_content) }; items.push(it); continue; }
      it.data = readMcq(q);
      if (!it.data.q) it.issues.push('no question text');
      if (it.data.o.length < 2) it.issues.push('no options');
      else if (!it.data.c.length) it.issues.push('no correct answer');
      if (it.data.c.length > 1) it.issues.push('more than one correct answer (Practice takes one)');
      if (/CODE_ANALYSIS/.test(type) && !it.data.code) it.issues.push('code snippet missing');
      if (/\[image: /.test(it.data.q) || /refer to the given image/i.test(it.data.q)) it.issues.push('refers to an image');
      it.data.c = it.data.c.length === 1 ? it.data.c[0] : 0;
      items.push(it);
    }
    for (const set of d.coding_practice || []) for (const q of set.questions || []) {
      const srcId = String(q.question_id || ''), lvl = String(q.question_difficulty || '').toLowerCase();
      const it = { file: f.name, srcId, kind: 'code', course, topic, type: String(q.question_type || 'CODING'), issues: [], skip: '' };
      if (course !== 'pf') { it.skip = course === 'wad' ? 'HTML/CSS coding: the Practice editor runs Python only.' : 'Workflow project (n8n), not a Python problem: the Practice editor runs Python only.'; it.data = { title: plain(q.question_short_text) }; items.push(it); continue; }
      it.data = { title: plain(first(q, ['question_short_text', 'title', 'question_title']) ?? ''), text: plain(first(q, ['question_content', 'content']) ?? ''),
        level: ['easy', 'medium', 'hard'].includes(lvl) ? lvl : 'medium', starter: String(first(q, ['starter_code', 'code_template', 'default_code']) ?? '').replace(/\r\n?/g, '\n'), tests: readTests(q) };
      if (!it.data.title) it.issues.push('no title');
      if (!it.data.tests.length) it.issues.push('no test cases');
      items.push(it);
    }
  }
  const sum = (f) => items.filter(f).length;
  return { items, problems, summary: { total: items.length, ready: sum((i) => !i.skip && !i.issues.length && i.course && i.topic), drafts: sum((i) => !i.skip && i.issues.length && i.course && i.topic), skipped: sum((i) => i.skip || !i.course || !i.topic) } };
}
