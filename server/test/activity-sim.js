// Runs the portal's activity counter (public/portal-bridge.js) in a fake browser with a fake clock, so time-on-portal
// rules can be checked against scripted student behaviour. Used by test/activity-time.test.js.
import vm from 'node:vm';

const listeners = (o) => { o._h = {}; o.addEventListener = (t, f) => (o._h[t] = o._h[t] || []).push(f); return o; };

export function loadPortalClass(source) {
  let Cls = null;
  const RealDate = Date;
  const env = { now: 1_800_000_000_000 };
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [env.now])); } static now() { return env.now; } }
  const ctx = {
    Date: FakeDate, Math, JSON, Object, Array, String, Number, Promise, Error, isFinite, console,
    setInterval: () => 0, clearInterval: () => {}, setTimeout: (f, ms) => { if (!ms) f(); return 0; }, clearTimeout: () => {},
    window: listeners({}), document: listeners({}), location: {}, navigator: { userAgent: 'sim' }, screen: {},
    fetch: () => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ serverNow: env.now, sprint: {}, user: { kind: 'student', photoAt: 1 } }) }),
    Component: class { constructor() { this.state = {}; } componentDidMount() {} renderVals() { return {}; } courseList() { return []; } },
    bootPortal: (c) => { Cls = c; }
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return new Promise((res) => setImmediate(() => res({ Cls, ctx, env })));
}

// One student session. `step` = 'watch' | 'play' | 'read' (Learn) or 'practice'.
export function session({ Cls, ctx, env }, step = 'read') {
  const doc = ctx.document, win = ctx.window;
  const page = { visible: true, focused: true, videos: [], frames: [] };
  doc.visibilityState = 'visible';
  doc.hasFocus = () => page.focused;
  doc.getElementsByTagName = (t) => (t === 'video' ? page.videos : t === 'iframe' ? page.frames : []);
  doc.activeElement = null;
  doc._h = {}; win._h = {};
  const p = Object.create(Cls.prototype);
  p.ss = { user: { kind: 'student' } };
  p.state = step === 'practice' ? { tab: 'practice', psess: 'Topic', tStart: null }
    : { tab: 'learn', course: 0, mod: 0, les: 0, ssTab: { u1: step }, tStart: null };
  p.courseList = () => [{ id: 'pf', modules: [{ lessons: [{ id: 'u1', tabs: {} }] }] }];
  // what the portal sends to the server: keep it instead of posting
  let sent = 0;
  p.ssActFlush = function () { Object.values(this._act.rows).forEach((r) => (sent += r.ms)); this._act.rows = {}; };
  p.ssActMount();
  const fire = (o, type, e) => (o._h[type] || []).forEach((f) => f(Object.assign({ type }, e)));
  const S = {
    // advance the clock second by second, as the portal's 1 s timer does
    wait(sec, every, act) { for (let i = 1; i <= sec; i++) { env.now += 1000; if (every && i % every === 0) act(); p.ssActTick(); } return S; },
    input(type = 'pointerdown') { fire(win, type); return S; },
    blur() { page.focused = false; fire(win, 'blur'); return S; },
    focus() { page.focused = true; return S; },
    hide() { page.visible = false; doc.visibilityState = 'hidden'; fire(doc, 'visibilitychange'); return S; },
    show() { page.visible = true; doc.visibilityState = 'visible'; return S; },
    video(playing) { page.videos = [{ paused: !playing, ended: false, readyState: 4 }]; return S; },
    // a Play/Read frame; sandboxed = the portal cannot read it (it posts { ssAct: 1 } instead)
    frame(sandboxed) {
      const fdoc = listeners({ readyState: 'complete', URL: 'https://site/packs/x.html' });
      const w = sandboxed ? { get document() { throw new Error('SecurityError'); } } : { document: fdoc };
      const el = { tagName: 'IFRAME', contentWindow: w };
      page.frames = [el]; doc.activeElement = el; S._fw = w; S._fdoc = fdoc;
      return S;
    },
    framePing() { fire(win, 'message', { data: { ssAct: 1 }, source: S._fw }); return S; },
    frameInput(type = 'wheel') { fire(S._fdoc, type); return S; },
    // seconds counted so far (what the portal will send to the server)
    seconds() { return (sent + Object.values(p._act.rows).reduce((n, r) => n + r.ms, 0)) / 1000; }
  };
  return S;
}

// [name, step, run(session) → session, expected seconds]
export const SCENARIOS = [
  ['Reads notes 10 min, scrolling every 30 s, then closes the tab', 'read', (s) => s.input().wait(600, 30, () => s.input()).hide(), 600],
  ['Opens the portal, clicks once, leaves it open in front for 60 min', 'read', (s) => s.input().wait(3600).hide(), 0],
  ['Works 5 min (click every 20 s), then walks away for 55 min', 'read', (s) => s.input().wait(300, 20, () => s.input()).wait(3300).hide(), 300],
  ['Portal visible but another app is in front for 30 min', 'read', (s) => s.input().blur().wait(1800).hide(), 0],
  ['Portal in a background tab for 30 min', 'read', (s) => s.input().hide().wait(1800), 0],
  ['Watches a 10 min video without touching anything', 'watch', (s) => s.video(true).wait(600).video(false).hide(), 600],
  ['Video paused, portal left open for 30 min', 'watch', (s) => s.input().video(false).wait(1800).hide(), 0],
  ['Plays a game in a sandboxed frame 10 min (input every 20 s)', 'play', (s) => s.frame(true).input().wait(600, 20, () => s.framePing()).hide(), 600],
  ['Clicks into a game frame, then leaves it for 30 min', 'play', (s) => s.frame(true).input().wait(1800).hide(), 0],
  ['Scrolls notes in a same-origin frame 10 min (every 30 s)', 'read', (s) => s.frame(false).input().wait(30).frameInput().wait(570, 30, () => s.frameInput()).hide(), 600],
  ['Pause longer than the limit (2 min 30 s) between two clicks', 'read', (s) => s.input().wait(150).input().hide(), 0],
  ['Reads 40 s without input, then switches to another app', 'read', (s) => s.input().wait(40).blur().wait(600).hide(), 40],
  ['Practice: thinks 2 min 30 s per question, answers 4 questions', 'practice', (s) => s.input().wait(600, 150, () => s.input()).hide(), 600],
  ['Practice: thinks 4 min on a question (over the 3 min limit)', 'practice', (s) => s.input().wait(240).input().hide(), 0]
];

export async function runAll(source) {
  const P = await loadPortalClass(source);
  return SCENARIOS.map(([name, step, run, expected]) => ({ name, expected, got: run(session(P, step)).seconds() }));
}
