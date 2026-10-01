// Small pool of grader worker threads per server instance (started lazily on first use, so it also
// works inside Vercel Functions). A worker that exceeds its time budget is terminated and replaced.
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';
import { ROOT, config } from './config.js';

const WORKER = path.join(ROOT, 'grader-worker.js');
const SIZE = Number(process.env.GRADER_THREADS || (config.isVercel ? 2 : Math.max(1, Math.min(4, os.cpus().length - 1))));
const LIMIT_MS = 2000;

const workers = [];
const queue = [];
let seq = 0, stopped = false;

function spawn() {
  const w = { t: null, busy: null, ready: false };
  w.t = new Worker(WORKER, { resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 } });
  w.t.on('message', (m) => {
    if (m.ready) { w.ready = true; pump(); if (!w.busy) w.t.unref(); return; }
    const job = w.busy;
    if (!job || m.id !== job.id) return;
    clearTimeout(job.timer);
    w.busy = null;
    w.t.unref();
    m.error ? job.reject(new Error(m.error)) : job.resolve(m.results);
    pump();
  });
  w.t.on('error', (e) => console.error('[grader] worker error:', e.message));
  w.t.on('exit', () => {
    const i = workers.indexOf(w);
    if (i >= 0) workers.splice(i, 1);
    if (w.busy) { clearTimeout(w.busy.timer); w.busy.reject(new Error('Grader stopped')); }
    if (!stopped && (queue.length || workers.length < SIZE)) workers.push(spawn());
  });
  return w;
}

function pump() {
  if (!stopped) while (workers.length < SIZE) workers.push(spawn());
  for (const w of workers) {
    if (!queue.length) return;
    if (!w.ready || w.busy) continue;
    const job = queue.shift();
    w.busy = job;
    w.t.ref(); // keep the process alive while a job runs
    job.timer = setTimeout(() => {
      job.reject(new Error('Grading timed out'));
      w.busy = null;
      w.t.terminate();
    }, job.tests.length * (LIMIT_MS + 1000) + 5000);
    w.t.postMessage({ id: job.id, code: job.code, tests: job.tests, limitMs: LIMIT_MS });
  }
}

export function startGrader() { stopped = false; pump(); }
export async function stopGrader() {
  stopped = true;
  await Promise.all(workers.splice(0).map((w) => w.t.terminate()));
}

// tests: [[input, expected, hidden?], ...] → [{pass, err}]
export function runTests(code, tests) {
  stopped = false;
  return new Promise((resolve, reject) => {
    queue.push({ id: ++seq, code: String(code || ''), tests: tests.map((t) => [t[0], t[1]]), resolve, reject });
    pump();
  });
}
