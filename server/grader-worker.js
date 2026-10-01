// Worker thread that runs student Python with Skulpt in an isolated vm context.
// Skulpt's bridges to JavaScript (jseval) are removed and only pure-computation modules can be imported,
// so submitted Python cannot reach Node APIs. Each worker has its own memory cap; a stuck worker is terminated.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor');
const ctx = { console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Promise };
ctx.window = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(dir, 'skulpt.min.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(dir, 'skulpt-stdlib.js'), 'utf8'), ctx);
const Sk = ctx.Sk;

for (const k of ['jseval', 'jsmillis']) { delete Sk.builtins[k]; delete Sk.builtin[k]; }
const ALLOWED = new Set(['math', 'random', 'string', 're', 'collections', 'itertools', 'operator', 'array', 'time', 'token', 'tokenize']);
const libFile = (f) => { const m = /^src\/lib\/([a-z_]+)(\/__init__)?\.(js|py)$/.exec(f); return m ? m[1] : null; };

function runPy(code, input, limitMs) {
  let out = '';
  const q = String(input == null ? '' : input).split('\n');
  Sk.configure({
    output: (t) => { if (out.length < 20000) out += t; },
    read: (f) => {
      const mod = libFile(f);
      if ((/^src\/builtin\//.test(f) || (mod && ALLOWED.has(mod))) && Sk.builtinFiles && Sk.builtinFiles.files[f] !== undefined) return Sk.builtinFiles.files[f];
      throw new Error('Module not available here: ' + f);
    },
    inputfun: () => (q.length ? q.shift() : ''), inputfunTakesPrompt: true,
    __future__: Sk.python3, execLimit: limitMs
  });
  return Sk.misceval.asyncToPromise(() => Sk.importMainWithBody('<stdin>', false, String(code), true))
    .then(() => ({ out, err: '' }), (e) => ({ out, err: String(e && e.toString ? e.toString() : e) }));
}

const normOut = (s) => String(s).replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
const squash = (s) => normOut(s).replace(/\s+/g, '');

parentPort.on('message', async (job) => {
  const results = [];
  try {
    let timedOut = false;
    for (const [input, expected] of job.tests) {
      // After one test hits the time limit (usually an infinite loop), fail the rest instead of burning
      // 2 s of CPU on each — this keeps a small server safe when many such submissions arrive at once.
      if (timedOut) { results.push({ pass: false, err: 'Skipped: an earlier test ran out of time.' }); continue; }
      const r = await runPy(job.code, input, job.limitMs || 2000);
      if (/TimeLimitError/.test(r.err)) timedOut = true;
      results.push({ pass: !r.err && (normOut(r.out) === normOut(expected) || squash(r.out) === squash(expected)), err: r.err ? r.err.slice(0, 300) : '' });
    }
    parentPort.postMessage({ id: job.id, results });
  } catch (e) {
    parentPort.postMessage({ id: job.id, error: String((e && e.message) || e) });
  }
});
parentPort.postMessage({ ready: true });
