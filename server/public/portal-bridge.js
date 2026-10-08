/* Saturday Sprint · portal bridge
 * Connects the single-file portal to the server without changing its look:
 *  - boots only after /api/bootstrap confirms a login session (otherwise → /login)
 *  - Sprint test: questions come from the server when the test starts; answers autosave;
 *    hidden tests and final grading run on the server
 *  - leaderboard tab, Home card and post-test standings
 *  - lesson/practice progress synced to the account
 *  - activity for Student analytics: active time and clicks per area / unit / step, video watch time (ssActMount)
 *  - Sprint proctoring: full screen, tab-switch detection, copy blocking, activity log (see ssProctorMount)
 */
(function () {
  'use strict';
  var clock = { offset: 0 }; // serverNow - Date.now()
  var PROGRESS_KEYS = ['done', 'solved', 'pPick', 'pSel', 'course', 'pc', 'pcSet', 'ssTab', 'stepDone'];

  function api(method, url, body, opts) {
    var init = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    if (opts && opts.keepalive) init.keepalive = true;
    return fetch(url, init).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (res.status === 401) { location.href = '/login'; throw Object.assign(new Error('Please log in again.'), { code: 'AUTH' }); }
        if (!res.ok) throw Object.assign(new Error((data && data.message) || 'Request failed (' + res.status + ')'), { code: data && data.error, status: res.status });
        return data;
      });
    }, function () {
      throw Object.assign(new Error('No connection to the server. Check your internet.'), { code: 'NETWORK' });
    });
  }

  var toLocal = function (serverMs) { return serverMs - clock.offset; };
  var fmtScore = function (x) { return x == null ? '–' : String(Math.round(Number(x) * 100) / 100); };

  function placeholders(types) {
    return (types || []).map(function (t) {
      if (t.type === 'mcq') return { course: t.course, type: 'mcq', q: '', o: [], c: -1 };
      if (t.type === 'code') return { course: t.course, type: 'code', q: '', starter: '', sample: ['', ''], tests: [] };
      return { course: t.course, type: 'text', q: '' };
    });
  }
  function fromServer(qs) {
    return qs.map(function (q) {
      var o = { course: q.course, type: q.type, q: q.q };
      if (q.code) o.code = q.code;
      if (q.type === 'mcq') { o.o = q.o; o.c = -1; }
      if (q.type === 'code') {
        o.starter = q.starter || ''; o.sample = q.sample || ['', ''];
        o.tests = []; for (var i = 0; i < (q.testCount || 0); i++) o.tests.push(['', '', true]);
      }
      return o;
    });
  }
  function draftToState(d) {
    d = d || {};
    var s = { tAns: {}, tText: {}, code: {} };
    Object.keys(d.mcq || {}).forEach(function (i) { s.tAns[i] = d.mcq[i]; });
    Object.keys(d.text || {}).forEach(function (i) { s.tText[i] = d.text[i]; });
    Object.keys(d.code || {}).forEach(function (i) { s.code['t' + i] = d.code[i]; });
    return s;
  }

  // Class declared by the portal script (global lexical binding).
  /* global Component, bootPortal */
  class SprintPortal extends Component {
    constructor() {
      super();
      var B = window.__ssBoot, S = this.state;
      this.ss = B;
      this.OPEN = toLocal(B.sprint.openMs);
      this.CLOSE = toLocal(B.sprint.closeMs);
      this.DUR = B.sprint.durMs;
      this.test = placeholders(B.sprint.types);

      // Units from content/units.json. mode "replace": they replace the course's original units;
      // "append": they come after them. Each unit is Video → Play → Read.
      var self = this, pack = Array.isArray(B.units) ? { mode: 'append', units: B.units } : (B.units || { units: [] });
      // Courses added in Admin → Courses & topics get their own module list (see courseList below).
      (B.courses || []).forEach(function (c) { self['_ssMods_' + c.id] = []; });
      var field = function (c) { return c === 'pf' ? 'pfModules' : c === 'genai' ? 'modules' : Array.isArray(self['_ssMods_' + c]) ? '_ssMods_' + c : null; };
      // "replaced" lists every course the units replace, even one whose units an admin removed (it must not fall back to the original lessons).
      if (pack.mode === 'replace') (pack.replaced || pack.units.map(function (u) { return u.course; })).forEach(function (c) { var f = field(c); if (f && !self['_ssReplaced' + f]) { self[f] = []; self['_ssReplaced' + f] = true; } });
      pack.units.forEach(function (u) {
        var f = field(u.course);
        if (f && !self[f].some(function (m) { return m._pack && m.name === u.name; })) self[f].push({ name: u.name, color: u.color, lessons: u.lessons, _pack: true });
      });
      // Lesson progress is stored by position; when the course content changes, old ticks would land on new lessons.
      this._ssContentV = this.courseList().map(function (c) { return c.id + ':' + c.modules.map(function (m) { return m.lessons.map(function (l) { return l.id; }).join(','); }).join('|'); }).join(';');

      var p = B.progress || {};
      var sameContent = p.cv === this._ssContentV, moved = !sameContent;
      // Progress is stored by position; when topics were added, removed or reordered, move each tick to where
      // its lesson is now (matched by lesson id through the content version saved with it).
      if (!sameContent && p.cv) {
        var posOf = function (cv) {
          var m = {};
          String(cv).split(';').forEach(function (seg) {
            var k = seg.indexOf(':'); if (k < 0) return;
            var cid = seg.slice(0, k);
            seg.slice(k + 1).split('|').forEach(function (mods, mi) { mods.split(',').forEach(function (lid, li) { if (lid) m[cid + '-' + mi + '-' + li] = cid + '/' + lid; }); });
          });
          return m;
        };
        var oldPos = posOf(p.cv), newPos = {}, cur = posOf(this._ssContentV);
        Object.keys(cur).forEach(function (k) { newPos[cur[k]] = k; });
        var remap = function (obj) {
          var out = {};
          Object.keys(obj || {}).forEach(function (k) {
            var m = /^([^:]+)(:.*)?$/.exec(k), at = m && oldPos[m[1]] && newPos[oldPos[m[1]]];
            if (at && obj[k]) out[at + (m[2] || '')] = obj[k];
          });
          return out;
        };
        p = Object.assign({}, p, { done: remap(p.done), stepDone: remap(p.stepDone) });
        sameContent = true;
      }
      PROGRESS_KEYS.forEach(function (k) { if (p[k] !== undefined && (k !== 'done' || sameContent)) S[k] = p[k]; });
      if (moved) { S.course = 0; S.mod = 0; S.les = 0; }
      if (p.code) S.code = Object.assign({}, S.code, p.code);

      var a = B.attempt;
      if (a && a.status === 'running') {
        this.test = fromServer(a.questions);
        var d = draftToState(a.draft);
        S.tStart = toLocal(a.startedAt); S.tAns = d.tAns; S.tText = d.tText; S.code = Object.assign({}, S.code, d.code);
        S.tab = 'test';
      } else if (a && a.status === 'submitted') {
        S.tStart = toLocal(a.startedAt); S.tDone = true; S.tGraded = true;
        S.tDoneAt = toLocal(a.submittedAt); S.ssResult = a.result; S.tCodeRes = a.result.codeRes || {};
        S.fbTestDone = !!B.testFeedbackDone;
      }
      // Admin previews are never asked for Sprint feedback (it is not stored for admins, so the form would return on every visit).
      if (B.user && B.user.kind === 'admin') {
        S.fbTestDone = true;
      }
      this._ssLast = { draft: '', progress: JSON.stringify(this.ssProgress()) };
    }

    componentDidMount() {
      super.componentDidMount();
      var self = this;
      // Autosave only when something changed. Intervals carry per-student jitter so 15,000 browsers don't sync in lockstep.
      var jitter = function (ms) { return ms + Math.floor(Math.random() * ms * 0.3); };
      this._ssDraftT = setInterval(function () { self.ssSaveDraft(); }, jitter(15000));
      this._ssProgT = setInterval(function () { self.ssSaveProgress(); }, jitter(30000));
      this._ssBoardT = setInterval(function () { if (self.ssWantsBoard() && document.visibilityState !== 'hidden') self.ssLoadBoard(); }, jitter(30000));
      var flush = function () { self.ssSaveDraft(true); self.ssSaveProgress(true); };
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });
      this.ssLoadBoard();
      this.ssProctorMount();
      this.ssActMount();
    }

    // ---------- persistence
    ssProgress() {
      var S = this.state, out = {};
      PROGRESS_KEYS.forEach(function (k) { if (S[k] !== undefined) out[k] = S[k]; });
      out.cv = this._ssContentV;
      out.code = {};
      Object.keys(S.code || {}).forEach(function (k) { if (!/^t\d+$/.test(k)) out.code[k] = S.code[k]; });
      return out;
    }
    ssSaveProgress(beacon) {
      if (this.ss.user.kind !== 'student') return;
      var json = JSON.stringify(this.ssProgress());
      if (json === this._ssLast.progress) return;
      var self = this;
      api('PUT', '/api/progress', { data: JSON.parse(json) }, { keepalive: !!beacon }).then(function () { self._ssLast.progress = json; }, function () {});
    }
    ssAnswers() {
      var S = this.state, out = { mcq: {}, text: {}, code: {} };
      this.test.forEach(function (q, i) {
        if (q.type === 'mcq' && S.tAns[i] !== undefined) out.mcq[i] = S.tAns[i];
        else if (q.type === 'text' && S.tText[i]) out.text[i] = S.tText[i];
        else if (q.type === 'code' && S.code['t' + i] !== undefined) out.code[i] = S.code['t' + i];
      });
      return out;
    }
    ssRunning() { var S = this.state; return S.tStart !== null && !S.tDone && !S.tGraded; }
    ssSaveDraft(beacon) {
      if (!this.ssRunning()) return;
      var body = this.ssAnswers(), json = JSON.stringify(body);
      if (json === this._ssLast.draft) return;
      var self = this;
      api('PUT', '/api/sprint/draft', body, { keepalive: !!beacon }).then(function () { self._ssLast.draft = json; }, function (e) {
        if (e.code === 'NETWORK') self.ssToast('Offline: your answers will be saved when the connection is back.', true);
      });
    }

    // ---------- Sprint test
    ssStart() {
      if (this._ssStarting) return;
      this._ssStarting = true;
      var self = this;
      api('POST', '/api/sprint/start').then(function (r) {
        var a = r.attempt;
        clock.offset = r.serverNow - Date.now();
        if (a.status === 'submitted') { location.reload(); return; }
        self.test = fromServer(a.questions);
        var d = draftToState(a.draft);
        self.setState(function (s) {
          return { tStart: toLocal(a.startedAt), now: Date.now(), tCur: 0, tAns: d.tAns, tText: d.tText, code: Object.assign({}, s.code, d.code) };
        });
      }, function (e) {
        self.ssToast(e.message, true);
        if (e.code === 'ALREADY_SUBMITTED') setTimeout(function () { location.reload(); }, 1500);
      }).then(function () { self._ssStarting = false; });
    }
    ssCheck(index, key) {
      var self = this, q = this.test[index];
      var code = this.state.code[key] !== undefined ? this.state.code[key] : q.starter;
      this.setState(function (s) { var c = Object.assign({}, s.ctests); c[key] = 'running'; return { ctests: c }; });
      api('POST', '/api/sprint/check', { index: index, code: code }).then(function (r) {
        self.setState(function (s) {
          var c = Object.assign({}, s.ctests);
          c[key] = r.results.map(function (x) { return { pass: x.pass, hid: true, i: '', e: '', g: '' }; });
          return { ctests: c };
        });
      }, function (e) {
        self.setState(function (s) { var c = Object.assign({}, s.ctests); c[key] = null; return { ctests: c }; });
        self.ssToast(e.message, true);
      });
    }
    gradeTest() {
      if (this._grading || Date.now() < (this._ssRetryAt || 0)) return Promise.resolve();
      // When the timer runs out, everyone's browser would submit in the same second. Spread those automatic
      // submissions over ~20 s (the server accepts them for 90 s after the deadline); manual submits go at once.
      if (!this.state.tDoneAt && !this._ssSpread) {
        this._ssSpread = true; this._ssRetryAt = Date.now() + Math.floor(Math.random() * 20000);
        this.setState({ tDone: true, ssSubmitting: true });
        this.ssSaveDraft(true);
        return Promise.resolve();
      }
      this._grading = true;
      var self = this;
      this.setState({ tDone: true, ssSubmitErr: '', ssSubmitting: true });
      return api('POST', '/api/sprint/submit', this.ssAnswers()).then(function (r) {
        var a = r.attempt;
        self._grading = false;
        self.setState({ tGraded: true, tDone: true, ssSubmitting: false, tDoneAt: toLocal(a.submittedAt), ssResult: a.result, tCodeRes: a.result.codeRes || {} });
        self.ssLoadBoard(true);
      }, function (e) {
        self._grading = false;
        self._ssRetryAt = Date.now() + 8000;
        self.setState({ ssSubmitting: false, ssSubmitErr: e.message + ' Your answers are saved. Try again.' });
      });
    }

    // ---------- activity (Admin → Student analytics)
    // Counts time the student is PRESENT only. An open tab, a window behind another app, or a portal left on screen
    // counts nothing. Time counts when:
    //   - a video is playing in the visible page, or the Sprint test is running (the test has its own clock), or
    //   - the window is focused and there is a click, key, scroll or mouse move (also inside Play/Read frames) at least
    //     every few minutes (ssActIdleMs). Time between two inputs is held back and kept only when the next input
    //     comes in time, so a student who walks away adds nothing, not even the minutes before the idle limit.
    // Opening a unit or a step counts as one click ("open").
    ssActKey() {
      var S = this.state;
      if (S.tab === 'learn') {
        var CO = this.courseList()[S.course], mod = CO && CO.modules[S.mod], les = mod && mod.lessons[S.les];
        if (!les) return 'learn||';
        return 'learn|' + les.id + '|' + (les.tabs ? ((S.ssTab || {})[les.id] || 'watch') : '');
      }
      if (S.tab === 'practice') return 'practice|' + (S.psess || this._ssPTopic || '') + '|';
      if (S.tab === 'code') return 'code|' + (S.csel || '') + '|';
      if (S.tab === 'test' || S.tab === 'board') return S.tab + '||';
      return 'home||';
    }
    ssActRow(key) { var A = this._act; return A.rows[key] || (A.rows[key] = { ms: 0, opens: 0, videoMs: 0, videoPct: 0, firstAt: Date.now() + clock.offset }); }
    // A visit (session) starts when the portal opens, and again after 30 minutes without activity.
    ssActSession(fresh) {
      var A = this._act, now = Date.now();
      if (fresh || !A.session || now - A.lastCounted > 30 * 60000) A.session = { id: Math.random().toString(36).slice(2, 10) + '-' + now.toString(36), startedAt: now + clock.offset };
      return A.session;
    }
    ssActTick() {
      var A = this._act, now = Date.now();
      if (!A) return;
      var key = this.ssActKey();
      if (key !== A.key) { A.key = key; this.ssActRow(key).opens++; }
      this.ssActHookFrames();
      var gap = Math.min(5000, Math.max(0, now - A.lastTick));
      A.lastTick = now;
      if (document.visibilityState !== 'visible') { A.pend = {}; return; }
      if (this.ssActPlaying() || (key.split('|')[0] === 'test' && this.ssRunning())) {
        this.ssActCommit(); this.ssActAdd(key, gap);
      } else if (document.hasFocus() && now - A.lastInput < this.ssActIdleMs(key)) {
        A.pend[key] = (A.pend[key] || 0) + gap;
      } else A.pend = {}; // idle too long or the window is in the background: the held-back time is dropped
    }
    ssActAdd(key, ms) { var A = this._act; this.ssActSession(); this.ssActRow(key).ms += ms; A.lastCounted = Date.now(); }
    // An input proves the student was there: keep the time held back since the previous one.
    ssActCommit() {
      var A = this._act, self = this;
      Object.keys(A.pend).forEach(function (k) { if (A.pend[k]) self.ssActAdd(k, A.pend[k]); });
      A.pend = {};
    }
    // The longest pause between inputs that still counts as working: reading a question or a screen of notes.
    ssActIdleMs(key) {
      var area = key.split('|')[0];
      if (area === 'learn') return 2 * 60000;
      if (area === 'practice' || area === 'code') return 3 * 60000;
      return 60000;
    }
    // Inputs inside Play/Read frames. Same-origin frames are listened to directly; sandboxed (uploaded) pages post
    // { ssAct: 1 } from a small script the server adds to them (GET /api/content/...).
    ssActHookFrames() {
      var A = this._act, fs = document.getElementsByTagName('iframe');
      for (var i = 0; i < fs.length; i++) {
        var d = null;
        try { d = fs[i].contentWindow && fs[i].contentWindow.document; } catch (e) { continue; } // sandboxed: reports through postMessage
        // a frame reused for the next unit gets a new document: hook each document once
        if (!d || A.hooked.indexOf(d) >= 0 || d.readyState === 'loading' || d.URL === 'about:blank') continue;
        ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll', 'mousemove'].forEach(function (t) { d.addEventListener(t, A.poke, { passive: true, capture: true }); });
        A.hooked.push(d); if (A.hooked.length > 20) A.hooked.shift();
      }
    }
    // A video is playing right now. Read from the players themselves: the reused player can switch to the next unit's
    // video mid-play without a pause event, which left a play counter stuck and counted idle time.
    ssActPlaying() {
      var vs = document.getElementsByTagName('video');
      for (var i = 0; i < vs.length; i++) if (!vs[i].paused && !vs[i].ended && vs[i].readyState > 2) return true;
      return false;
    }
    ssActFlush(beacon) {
      var A = this._act;
      if (!A) return;
      var items = Object.keys(A.rows).map(function (k) {
        var r = A.rows[k], parts = k.split('|');
        return { area: parts[0], item: parts[1], step: parts[2], ms: r.ms, opens: r.opens, videoMs: Math.round(r.videoMs), videoPct: Math.round(r.videoPct), firstAt: r.firstAt };
      }).filter(function (r) { return r.ms >= 1000 || r.opens || r.videoMs >= 1000; });
      if (!items.length) return;
      A.rows = {};
      api('POST', '/api/activity', { session: this.ssActSession(), items: items }, { keepalive: !!beacon }).catch(function () {
        items.forEach(function (r) { var x = A.rows[r.area + '|' + r.item + '|' + r.step] = A.rows[r.area + '|' + r.item + '|' + r.step] || { ms: 0, opens: 0, videoMs: 0, videoPct: 0 };
          x.ms += r.ms; x.opens += r.opens; x.videoMs += r.videoMs; x.videoPct = Math.max(x.videoPct, r.videoPct); });
      });
    }
    ssActVideo(el, src) {
      var self = this, last = null;
      el.addEventListener('timeupdate', function () {
        // one <video> element can be reused for the next unit: always use the source it plays now
        var A = self._act, cur = el._src; if (!A || !cur) return;
        if (cur !== src) { src = cur; last = null; }
        var unit = (self._ssVidUnit || {})[cur]; if (!unit) return;
        var row = self.ssActRow('learn|' + unit + '|watch'), t = el.currentTime;
        if (last !== null && !el.paused && t > last && t - last < 2) row.videoMs += (t - last) * 1000;
        last = t;
        if (isFinite(el.duration) && el.duration > 0) row.videoPct = Math.max(row.videoPct, Math.min(100, t / el.duration * 100 + (el.ended ? 100 : 0)));
      });
      el.addEventListener('seeking', function () { last = null; });
    }
    ssActMount() {
      if (this.ss.user.kind !== 'student') return;
      var self = this, A = this._act = { rows: {}, pend: {}, hooked: [], key: null, lastInput: Date.now(), lastTick: Date.now(), lastCounted: Date.now(), session: null };
      this.ssActSession(true);
      // input: the student is here (mouse moves are taken at most every 5 s)
      var lastPoke = 0;
      A.poke = function (e) {
        var n = Date.now();
        if (e && e.type === 'mousemove' && n - lastPoke < 5000) return;
        lastPoke = n;
        self.ssActTick(); // take the time up to this input first
        if (n - A.lastInput < self.ssActIdleMs(A.key || 'home||')) self.ssActCommit(); else A.pend = {};
        A.lastInput = n;
      };
      ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll', 'mousemove'].forEach(function (t) { window.addEventListener(t, A.poke, { passive: true, capture: true }); });
      window.addEventListener('message', function (e) {
        if (!e.data || e.data.ssAct !== 1) return;
        var fs = document.getElementsByTagName('iframe');
        for (var i = 0; i < fs.length; i++) if (fs[i].contentWindow === e.source) { A.poke(); return; }
      });
      // Leaving (another tab, another app, closing) right after working keeps the held-back time; later leaves drop it.
      var leave = function () { if (Date.now() - A.lastInput < self.ssActIdleMs(A.key || 'home||')) self.ssActCommit(); A.pend = {}; A.lastTick = Date.now(); };
      this._ssActT = setInterval(function () { self.ssActTick(); }, 1000);
      this._ssActF = setInterval(function () { self.ssActFlush(false); }, 120000 + Math.floor(Math.random() * 30000));
      // clicking into a Play/Read frame also blurs the window, but the page still has focus then
      window.addEventListener('blur', function () { setTimeout(function () { if (!document.hasFocus()) leave(); }, 0); });
      window.addEventListener('pagehide', function () { leave(); self.ssActFlush(true); });
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') { leave(); self.ssActFlush(true); } });
    }

    // ---------- proctoring (Sprint settings → Proctoring)
    // While the test runs: full screen (on computers), tab/window switches and full-screen exits are violations with a
    // warning; copy, select, right-click and print are blocked; activity goes to the server in batches. Past the limit
    // the server submits the attempt. A watermark with the NIAT ID covers the questions.
    ssProctorCfg() { return (this.ss.sprint && this.ss.sprint.proctor) || { enabled: false }; }
    ssEndAt() {
      var S = this.state;
      if (S.tStart === null) return 0;
      return this.ss.sprint.preview ? S.tStart + this.DUR : Math.min(S.tStart + this.DUR, this.CLOSE);
    }
    ssProctorActive() { return !!this.ssProctorCfg().enabled && this.ssRunning() && Date.now() < this.ssEndAt(); }
    // Copy protection covers the test screen from the start until the student leaves it (including the review after submitting).
    ssProtectActive() { var S = this.state; return !!this.ssProctorCfg().blockCopy && S.tab === 'test' && S.tStart !== null; }
    ssLog(type, detail, urgent) {
      var P = this._p;
      if (!P || !this.ssProctorCfg().enabled) return;
      // the same blocked action is reported at most once every 2 s
      if (!urgent) { var last = P.lastOf[type] || 0; if (Date.now() - last < 2000) return; P.lastOf[type] = Date.now(); }
      P.queue.push({ type: type, at: Date.now() + clock.offset, detail: detail == null ? null : String(detail).slice(0, 300) });
      if (urgent) this.ssFlushEvents(false, true);
    }
    ssFlushEvents(beacon, withAnswers) {
      var P = this._p, self = this;
      if (!P || (!P.queue.length && !withAnswers) || (P.sending && !beacon)) return;
      var events = P.queue.splice(0, 50);
      var body = { instance: P.inst, events: events };
      if (withAnswers && this.ssRunning()) body.answers = this.ssAnswers();
      P.sending = true;
      api('POST', '/api/sprint/events', body, { keepalive: !!beacon }).then(function (r) {
        P.sending = false;
        if (typeof r.violations === 'number') { P.count = Math.max(P.count, r.violations); P.max = r.max; self.ssOverlay(); }
        if (r.status === 'submitted' && r.attempt && r.attempt.result) self.ssEndedByProctor(r.attempt);
        if (P.queue.length) self.ssFlushEvents(false, false);
      }, function (e) {
        P.sending = false;
        if (e.code === 'NETWORK' || (e.status && e.status >= 500)) P.queue = events.concat(P.queue).slice(0, 200); // retry later
      });
    }
    ssEndedByProctor(a) {
      var P = this._p;
      if (P) P.ended = true;
      this.setState({ tGraded: true, tDone: true, ssSubmitting: false, tDoneAt: toLocal(a.submittedAt), ssResult: a.result, tCodeRes: a.result.codeRes || {} });
      this.ssLoadBoard(true);
      this.ssOverlay();
    }
    ssViolation(type, detail) {
      var P = this._p;
      if (!P || !P.on || P.ended || Date.now() < P.graceUntil) return;
      // leaving the tab also blurs the window: count it once
      if (Date.now() - P.lastViolationAt < 1500) { this.ssLog(type, detail, false); return; }
      P.lastViolationAt = Date.now();
      P.count++; P.warn = { type: type, at: Date.now() };
      this.ssLog(type, detail, true);
      this.ssOverlay();
    }
    ssFsSupported() { var d = document.documentElement; return !!(document.fullscreenEnabled && d.requestFullscreen); }
    ssFsNeeded() { return !!this.ssProctorCfg().fullscreen && this.ssFsSupported(); }
    ssEnterFs() {
      var self = this;
      if (!this.ssFsNeeded() || document.fullscreenElement) return;
      try {
        var p = document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        if (p && p.catch) p.catch(function (e) { self.ssLog('fs_denied', e && e.message); });
      } catch (e) { this.ssLog('fs_denied', e.message); }
    }
    ssProctorTick() {
      var S = this.state, P = this._p, active = this.ssProctorActive();
      document.body.classList.toggle('ss-noselect', this.ssProtectActive());
      if (!P) return;
      if (active && !P.on) {
        P.on = true; P.graceUntil = Date.now() + 2500;
        this.ssLog(P.started ? 'start' : 'resume', 'screen ' + screen.width + '×' + screen.height + ' · full screen ' + (this.ssFsSupported() ? 'supported' : 'not supported') + ' · ' + navigator.userAgent.slice(0, 160), true);
        if (!this.ssFsSupported() && this.ssProctorCfg().fullscreen) this.ssLog('fs_unsupported', null);
        if (P.bc) try { P.bc.postMessage({ t: 'hello', inst: P.inst }); } catch (e) {}
        this._ssHb = setInterval(function () { if (P.on) { P.queue.push({ type: 'hb', at: Date.now() + clock.offset }); } }, 60000);
      } else if (!active && P.on) {
        P.on = false; clearInterval(this._ssHb);
        this.ssFlushEvents(false, false);
        if (document.fullscreenElement && !P.ended) { try { document.exitFullscreen(); } catch (e) {} }
      }
      if (active && S.tab !== 'test') this.setState({ tab: 'test' });
      this.ssWatermark(active || this.ssProtectActive());
      this.ssOverlay();
    }
    ssWatermark(on) {
      var el = document.getElementById('ss-wm');
      if (!on) { if (el) el.remove(); return; }
      if (el) return;
      var U = this.ss.user, label = (U.rollNo || U.email || '') + ' · ' + (U.name || '');
      var esc = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='340' height='180'><text x='20' y='100' transform='rotate(-18 170 90)' fill='rgba(255,255,255,0.07)' font-family='monospace' font-size='15'>" + esc + '</text></svg>';
      el = document.createElement('div'); el.id = 'ss-wm'; el.setAttribute('aria-hidden', 'true');
      el.style.backgroundImage = 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '")';
      document.body.appendChild(el);
    }
    // One overlay for: the rules before starting, the full-screen gate, warnings, another open tab, and the end.
    ssOverlay() {
      var P = this._p, S = this.state, self = this;
      if (!P) return;
      var cfg = this.ssProctorCfg(), mode = null;
      if (P.ended) mode = 'ended';
      else if (P.rules) mode = 'rules';
      else if (P.on && P.blocked) mode = 'multi';
      else if (P.on && P.warn) mode = 'warn';
      else if (P.on && this.ssFsNeeded() && !document.fullscreenElement) mode = 'fs';
      var el = document.getElementById('ss-proctor');
      if (!mode) { if (el) el.remove(); return; }
      var key = mode + ':' + P.count + ':' + (P.max || '');
      if (el && el.dataset.key === key) return;
      if (!el) { el = document.createElement('div'); el.id = 'ss-proctor'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); document.body.appendChild(el); }
      el.dataset.key = key;
      var max = P.max != null ? P.max : cfg.maxViolations;
      var left = max > 0 ? Math.max(0, max - P.count) : null;
      var REASON = { tab_hidden: 'You left the test tab.', window_blur: 'You switched to another window or app.', fs_exit: 'You left full screen.', multi_instance: 'The test is open somewhere else.' };
      var T = {
        rules: ['Before you start', 'This is a proctored test, like a hiring assessment.',
          [this.ssFsNeeded() ? 'It runs in full screen. Leaving full screen is a violation.' : null,
            'Leaving this tab, switching to another app or window, or opening the test in another tab is a violation.',
            max > 0 ? 'After ' + max + ' violation' + (max === 1 ? '' : 's') + ' the test is submitted automatically with the answers you have.' : 'Every violation is recorded and seen by the admins.',
            cfg.blockCopy ? 'Copying, selecting text, right-click and printing are disabled.' : null,
            'Your activity is recorded with your NIAT ID. The timer starts when you press Start.'], 'Start the test', 'Not now'],
        fs: ['Back to full screen', 'The Sprint runs in full screen. Your timer is still running.', [], 'Return to full screen'],
        warn: ['Warning ' + P.count + (max > 0 ? ' of ' + max : ''), (REASON[P.warn && P.warn.type] || 'Activity outside the test was detected.') + ' This is recorded.',
          [left === null ? 'Stay on this screen until you submit.' : left > 0 ? left + ' more violation' + (left === 1 ? '' : 's') + ' and your test is submitted automatically.' : 'Your test is being submitted.'],
          this.ssFsNeeded() && !document.fullscreenElement ? 'Return to full screen and continue' : 'Continue the test'],
        multi: ['Test open in another tab', 'The Sprint is already open in another tab of this browser. Close this tab and continue there.', ['This was recorded as a violation.'], null],
        ended: ['Test submitted', 'Your Sprint was submitted automatically after ' + P.count + ' violation' + (P.count === 1 ? '' : 's') + '.', ['Your answers up to that moment were graded. Your score is on the result screen.'], 'View my result']
      }[mode];
      var box = document.createElement('div'); box.className = 'ss-pbox' + (mode === 'warn' || mode === 'multi' || mode === 'ended' ? ' bad' : '');
      var k = document.createElement('div'); k.className = 'ss-pk'; k.textContent = mode === 'rules' ? 'proctored · ' + Math.round(this.DUR / 60000) + ' min' : 'sprint · proctoring'; box.appendChild(k);
      var h = document.createElement('h2'); h.textContent = T[0]; box.appendChild(h);
      var p = document.createElement('p'); p.textContent = T[1]; box.appendChild(p);
      var items = T[2].filter(Boolean);
      if (items.length) { var ul = document.createElement('ul'); items.forEach(function (t) { var li = document.createElement('li'); li.textContent = t; ul.appendChild(li); }); box.appendChild(ul); }
      var row = document.createElement('div'); row.className = 'ss-prow';
      if (T[3]) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'ss-pbtn'; b.textContent = T[3];
        b.onclick = function () {
          if (mode === 'rules') { P.rules = false; P.started = true; self.ssEnterFs(); self.ssStart(); }
          else if (mode === 'ended') { P.ended = false; P.warn = null; }
          else { if (mode === 'warn') { self.ssLog('warning_ack', 'warning ' + P.count); P.warn = null; } P.graceUntil = Date.now() + 1500; self.ssEnterFs(); }
          self.ssOverlay();
        };
        row.appendChild(b);
      }
      if (T[4]) { var c = document.createElement('button'); c.type = 'button'; c.className = 'ss-pbtn ghost'; c.textContent = T[4]; c.onclick = function () { P.rules = false; self.ssOverlay(); }; row.appendChild(c); }
      box.appendChild(row);
      el.replaceChildren(box);
      var first = el.querySelector('button'); if (first) try { first.focus(); } catch (e) {}
    }
    ssProctorMount() {
      var self = this, cfg = this.ssProctorCfg();
      if (!cfg.enabled && !cfg.blockCopy) return;
      var inst;
      try { inst = sessionStorage.getItem('ss-inst'); if (!inst) { inst = Math.random().toString(36).slice(2, 10); sessionStorage.setItem('ss-inst', inst); } } catch (e) { inst = Math.random().toString(36).slice(2, 10); }
      var P = this._p = { inst: inst, queue: [], lastOf: {}, on: false, count: this.ss.violations || 0, max: cfg.maxViolations, graceUntil: 0, lastViolationAt: 0, warn: null, rules: false, started: false };
      if (!document.getElementById('ss-proctor-css')) {
        var st = document.createElement('style'); st.id = 'ss-proctor-css';
        st.textContent = [
          'body.ss-noselect, body.ss-noselect *{-webkit-user-select:none !important;user-select:none !important;-webkit-touch-callout:none !important}',
          'body.ss-noselect input, body.ss-noselect textarea{-webkit-user-select:text !important;user-select:text !important}',
          '@media print{body.ss-noselect *{display:none !important}body.ss-noselect:after{content:"Printing is disabled during the Sprint.";display:block;padding:40px;font:20px monospace}}',
          '#ss-wm{position:fixed;inset:0;pointer-events:none;z-index:2147482000}',
          '#ss-proctor{position:fixed;inset:0;z-index:2147483000;background:#050505;display:flex;align-items:center;justify-content:center;padding:16px;font-family:"JetBrains Mono",monospace;color:#fff}',
          '#ss-proctor .ss-pbox{max-width:560px;width:100%;background:#151515;border:2px solid #FFE45C;border-radius:20px;padding:26px;display:flex;flex-direction:column;gap:12px;box-shadow:0 30px 60px -20px #000}',
          '#ss-proctor .ss-pbox.bad{border-color:#FF7A7A}',
          '#ss-proctor .ss-pk{font-family:VT323,monospace;font-size:20px;color:#FFE45C}',
          '#ss-proctor .bad .ss-pk{color:#FF7A7A}',
          '#ss-proctor h2{margin:0;font-size:24px;font-weight:800}',
          '#ss-proctor p{margin:0;font-size:15px;line-height:1.55;color:#EDEDED}',
          '#ss-proctor ul{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px;font-size:14px;line-height:1.5;color:#BDBDBD}',
          '#ss-proctor .ss-prow{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}',
          '#ss-proctor .ss-pbtn{min-height:50px;padding:0 22px;border:0;border-radius:12px;background:#FFE45C;color:#050505;font:800 16px "JetBrains Mono",monospace;cursor:pointer}',
          '#ss-proctor .ss-pbtn.ghost{background:transparent;color:#fff;border:2px solid #333}'
        ].join('\n');
        document.head.appendChild(st);
      }
      var inInput = function (t) { return t && t.closest && t.closest('input, textarea, [contenteditable="true"]'); };
      var protect = function () { return self.ssProtectActive(); };
      ['copy', 'cut', 'paste'].forEach(function (type) {
        document.addEventListener(type, function (e) { if (!protect()) return; e.preventDefault(); self.ssLog(type, null); }, true);
      });
      document.addEventListener('contextmenu', function (e) { if (!protect()) return; e.preventDefault(); self.ssLog('contextmenu', null); }, true);
      document.addEventListener('selectstart', function (e) { if (!protect() || inInput(e.target)) return; e.preventDefault(); }, true);
      document.addEventListener('dragstart', function (e) { if (!protect()) return; e.preventDefault(); self.ssLog('drag_blocked', null); }, true);
      document.addEventListener('keydown', function (e) {
        if (!protect()) return;
        var k = String(e.key || '').toLowerCase(), mod = e.ctrlKey || e.metaKey;
        var bad = (mod && ['c', 'x', 'v', 'a', 'p', 's', 'u'].indexOf(k) >= 0) ||
          k === 'f12' || (mod && e.shiftKey && ['i', 'j', 'c', 'k'].indexOf(k) >= 0) || k === 'printscreen';
        if (!bad) return;
        e.preventDefault(); e.stopPropagation();
        self.ssLog(k === 'p' && mod ? 'print' : 'key_blocked', (mod ? (e.metaKey ? 'Cmd+' : 'Ctrl+') : '') + (e.shiftKey && mod ? 'Shift+' : '') + e.key);
      }, true);
      document.addEventListener('keyup', function (e) { if (protect() && String(e.key).toLowerCase() === 'printscreen') { self.ssLog('key_blocked', 'PrintScreen'); try { navigator.clipboard.writeText(''); } catch (x) {} } }, true);
      window.addEventListener('beforeprint', function () { if (protect()) self.ssLog('print', null); });
      document.addEventListener('visibilitychange', function () {
        if (!P.on) return;
        if (document.visibilityState === 'hidden') { self.ssViolation('tab_hidden', null); self.ssFlushEvents(true, true); }
        else self.ssLog('tab_visible', null, true);
      });
      var blurT = null;
      window.addEventListener('blur', function () {
        if (!P.on) return;
        clearTimeout(blurT);
        // short blurs (the browser's own UI) are ignored; a second or more in another window counts
        blurT = setTimeout(function () { if (P.on && document.visibilityState === 'visible' && !document.hasFocus()) self.ssViolation('window_blur', null); }, 1000);
      });
      window.addEventListener('focus', function () { clearTimeout(blurT); });
      document.addEventListener('fullscreenchange', function () {
        if (!P.on) { self.ssOverlay(); return; }
        if (document.fullscreenElement) { self.ssLog('fs_enter', null); P.graceUntil = Date.now() + 1500; }
        else if (self.ssFsNeeded() && self.ssProctorActive()) self.ssViolation('fs_exit', null);
        self.ssOverlay();
      });
      window.addEventListener('offline', function () { self.ssLog('offline', null); });
      window.addEventListener('online', function () { self.ssLog('online', null); self.ssFlushEvents(false, false); });
      window.addEventListener('pagehide', function () { self.ssFlushEvents(true, false); });
      // A second tab of this browser with the same running test
      if (window.BroadcastChannel) {
        try {
          P.bc = new BroadcastChannel('ss-proctor:' + (this.ss.user.rollNo || this.ss.user.email || ''));
          P.bc.onmessage = function (m) {
            var d = m.data || {};
            if (d.inst === P.inst) return;
            if (d.t === 'hello' && P.on) { P.bc.postMessage({ t: 'busy', inst: P.inst }); }
            if (d.t === 'busy' && P.on) { P.blocked = true; self.ssViolation('multi_instance', 'another tab of this browser'); self.ssOverlay(); }
          };
        } catch (e) {}
      }
      this._ssProcT = setInterval(function () { self.ssProctorTick(); }, 500);
      this._ssProcFlush = setInterval(function () { self.ssFlushEvents(false, false); }, 5000);
    }

    // ---------- leaderboard
    ssWantsBoard() {
      var S = this.state;
      return S.tab === 'home' || S.tab === 'board' || (S.tab === 'test' && S.tGraded);
    }
    ssLoadBoard(force) {
      if (this._ssBoardBusy && !force) return;
      this._ssBoardBusy = true;
      var self = this;
      api('GET', '/api/leaderboard?limit=100').then(function (b) {
        self.setState({ ssBoard: b, ssBoardAt: Date.now() });
      }, function () {}).then(function () { self._ssBoardBusy = false; });
    }
    ssBoardVals() {
      var B = this.state.ssBoard, self = this, S = this.state;
      var row = function (r) {
        var top = r.rank <= 3, tone = r.rank === 1 ? '#FFE45C' : r.rank === 2 ? '#EDEDED' : '#FF7A7A';
        return {
          rank: '#' + r.rank, name: r.name, id: r.id, batch: r.batch || '–',
          score: fmtScore(r.score) + ' / ' + fmtScore(r.maxTotal), time: self.mmss(r.usedMs || 0),
          youTag: r.me ? '· you' : '', ring: r.me ? '#FFE45C' : '#262626', bg: r.me ? 'rgba(255,228,92,.08)' : '#0D0D0D',
          rankBg: top ? tone : 'transparent', rankFg: top ? '#050505' : '#FFFFFF', rankRing: top ? tone : '#333333', rankText: top ? tone : '#BDBDBD'
        };
      };
      var rows = B && B.rows ? B.rows.map(row) : [];
      var me = B && B.me, inTop = function (n) { return me && rows.slice(0, n).some(function (r, i) { return B.rows[i].me; }); };
      var submitted = !!S.ssResult, student = this.ss.user.kind === 'student';
      var my = me ? { rank: '#' + me.rank, note: 'of ' + B.participants + ' on the board', score: fmtScore(me.score) + ' / ' + fmtScore(me.maxTotal), time: 'time ' + this.mmss(me.usedMs || 0) }
        : { rank: '–', note: !student ? 'Admin preview is not ranked' : submitted ? 'Updating…' : 'Submit the Sprint to get a rank', score: submitted ? fmtScore(S.ssResult.score) + ' / ' + fmtScore(S.ssResult.maxTotal) : '–', time: '' };
      var homeLine = !B ? 'Loading standings…' : B.hidden ? 'The leaderboard opens after the Sprint.' : me ? 'You are #' + me.rank + ' of ' + B.participants
        : rows.length ? 'Top of the board right now' : 'No results yet. Be the first on the board.';
      return {
        loading: !B, hidden: !!(B && B.hidden), rows: rows, top5: rows.slice(0, 5), top10: rows.slice(0, 10),
        hasRows: rows.length > 0, empty: !!B && rows.length === 0,
        emptyNote: B && B.hidden ? 'The leaderboard is hidden right now. It will appear here once the admins publish it.' : 'The board fills as soon as the first Sprint is submitted. It updates automatically.',
        meRows: me ? [row(me)] : [], meBelow: !!me && !inTop(100), meBelow10: !!me && !inTop(10),
        my: my, participants: B ? B.participants : 0, homeLine: homeLine,
        rule: (B && B.rule) || '', kicker: (B && B.title ? B.title + ' · ' : '') + 'auto-refreshes every 30s',
        updated: S.ssBoardAt ? 'updated ' + new Date(S.ssBoardAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '',
        refresh: function () { self.ssLoadBoard(true); }
      };
    }

    // MP4/WebM play natively in every browser. The portal's player sends every video through hls.js
    // (for .m3u8 streams), which cannot play MP4 in Chrome/Edge/Firefox; so only real streams go that way.
    vidRef(src) {
      if (src && !/\.m3u8(\?|$)/i.test(src)) return this.ssVideoRef(src);
      return super.vidRef(src);
    }
    ssVideoRef(src) {
      this._ssVref = this._ssVref || {};
      var self = this;
      return this._ssVref[src] || (this._ssVref[src] = function (el) {
        if (!el) return;
        // The portal's template turns the empty `controls` attribute into controls=false, which left
        // every video as a dark box with nothing to click. Force the native controls on.
        el.controls = true; el.playsInline = true;
        if (el._src === src) return;
        if (el._hls) { el._hls.destroy(); el._hls = null; }
        el._src = src; el._ssStarted = false; el.preload = 'metadata'; el.src = src;
        // Many learning bytes open on a black frame. Show a frame from ~3 s in as the cover,
        // and start from 0:00 when the student presses play.
        var cover = function () {
          if (el._src !== src || el._ssStarted || !el.paused || el.currentTime > 0) return;
          var t = Math.min(3, (isFinite(el.duration) ? el.duration : 10) * 0.15);
          el._ssCover = t;
          try { el.currentTime = t; } catch (e) {}
        };
        el.addEventListener('loadedmetadata', cover, { once: true });
        if (!el._ssActHook) { el._ssActHook = true; self.ssActVideo(el, src); }
        if (!el._ssPlayHook) {
          el._ssPlayHook = true;
          el.addEventListener('play', function () {
            if (!el._ssStarted && el._ssCover && Math.abs(el.currentTime - el._ssCover) < 0.25) el.currentTime = 0;
            el._ssStarted = true;
          });
        }
      });
    }
    ssToast(text, err) {
      var self = this, at = Date.now();
      this.setState({ ssToast: { text: text, err: !!err, at: at } });
      setTimeout(function () { if (self.state.ssToast && self.state.ssToast.at === at) self.setState({ ssToast: null }); }, 4500);
    }

    // Built-in courses, then the courses admins added that have at least one topic.
    courseList() {
      // Built-in courses an admin removed, or left without topics, are not shown.
      var hidden = (this.ss && this.ss.units && this.ss.units.hiddenCourses) || [], self = this;
      var list = super.courseList().filter(function (c) { return hidden.indexOf(c.id) < 0 && !(self.ss && c.modules.length === 0); });
      ((this.ss && this.ss.courses) || []).forEach(function (c) {
        var mods = self['_ssMods_' + c.id];
        if (mods && mods.length) list.push({ id: c.id, name: c.name, topic: '', color: c.color || '#FFE45C', modules: mods });
      });
      return list;
    }

    renderVals() {
      var v = super.renderVals(), S = this.state, self = this, U = this.ss.user;
      // the practice topic on screen (the portal picks a default when the student has not chosen one)
      if (v.pq && v.pq.topicLabel && v.pq.topicLabel !== 'Topic') this._ssPTopic = v.pq.topicLabel;
      var on = S.tab === 'board';
      v.nav.board = { go: function () { self.xpStop(); self.setState({ tab: 'board' }); self.ssLoadBoard(true); }, bg: on ? '#FFE45C' : 'transparent', fg: on ? '#050505' : '#FFFFFF' };
      v.show.board = on;
      if (on) v.crumb = '~/leaderboard';

      // Server-side results replace the in-browser score.
      var R = S.ssResult;
      if (R) {
        v.t.mcqScore = R.mcqRight + ' / ' + R.mcqN;
        v.t.probScore = R.probN ? R.probDone + ' / ' + R.probN : '–';
        v.t.used = this.mmss(R.usedMs || 0);
      } else if (v.t.done) { v.t.mcqScore = '…'; v.t.probScore = '…'; }
      // Test options: the portal letters them A–C; questions can have up to 6 options.
      if (v.tq && Array.isArray(v.tq.opts)) v.tq.opts.forEach(function (o, i) { o.k = 'ABCDEF'[i]; });
      v.t.start = function () {
        if (self._p && self.ssProctorCfg().enabled) { self._p.rules = true; self.ssOverlay(); return; }
        self.ssStart();
      };
      if (v.tq.isCode && S.tStart !== null) {
        var idx = S.tCur, key = 't' + idx;
        v.te.runTests = function () { self.ssCheck(idx, key); };
      }
      // Sprint date, time and duration from the server settings (shown in IST).
      var sp = this.ss.sprint, mins = Math.round(sp.durMs / 60000);
      var fmt = function (ms, o) { try { return new Date(ms).toLocaleString('en-IN', Object.assign({ timeZone: 'Asia/Kolkata' }, o)); } catch (e) { return new Date(ms).toLocaleString(); } };
      var tm = function (ms) { return fmt(ms, { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s?(am|pm)$/i, function (x) { return ' ' + x.trim().toUpperCase(); }); };
      var day = function (ms) { return fmt(ms, { weekday: 'short', day: 'numeric', month: 'short' }); };
      var sameDay = day(sp.openMs) === day(sp.closeMs);
      var when = {
        line: sameDay ? day(sp.openMs) + ' · ' + tm(sp.openMs) + ' – ' + tm(sp.closeMs) + ' IST'
          : day(sp.openMs) + ', ' + tm(sp.openMs) + ' – ' + day(sp.closeMs) + ', ' + tm(sp.closeMs) + ' IST',
        dur: mins + ' minutes', durCap: mins + ' minutes', close: sameDay ? tm(sp.closeMs) : day(sp.closeMs) + ', ' + tm(sp.closeMs)
      };
      if (v.status && /closes 11:30 AM/.test(v.status.top || '')) v.status.top = 'Sprint is live · closes ' + when.close;
      if (this.ss.sprint.preview) v.t.readyNote = '(Admin preview' + (sp.previewOf ? ' of Sprint "' + sp.previewOf + '"' : '') + ': opens any time, ' + mins + '-minute timer, not ranked.)';

      // Lessons: units are one lesson with three steps (Watch → Play → Read); older lessons keep their own media.
      var CO = this.courseList()[S.course], mod = CO && CO.modules[S.mod], les = mod && mod.lessons[S.les];
      var w = les && les.watch && typeof les.watch === 'object' ? les.watch : {};
      var portrait = w.orientation === 'portrait';
      if (v.wt) { v.wt.vw = portrait ? 'min(100%, 440px)' : '100%'; v.wt.aspect = portrait ? '9 / 16' : '16 / 9'; v.wt.tall = !!w.tall; }
      var unitsPrev = null;
      // Topic list: a tick when every lesson of the topic is done (a unit is done once its last step, Read, is finished).
      if (Array.isArray(v.lgroups)) {
        var CLs = this.courseList(), sdAll = S.stepDone || {}, doneAll = S.done || {};
        v.lgroups.forEach(function (g, ci) {
          var c = CLs[ci];
          (g.topics || []).forEach(function (t, mi) {
            var m = c && c.modules[mi];
            var dn = !!(m && m.lessons.length) && m.lessons.every(function (l, li) { var k = c.id + '-' + mi + '-' + li; return !!doneAll[k] || !!sdAll[k + ':read']; });
            var over = self.ss.unitContent || {};
            t.soon = !dn && !!(m && m.lessons.length) && m.lessons.every(function (l) {
              if (!l.tabs) return false;
              var o = over[l.id] || {};
              return !['watch', 'play', 'read'].some(function (k) { return o[k] || (l.tabs[k] && l.tabs[k].src); });
            });
            t.soonFg = t.on ? '#050505' : '#8A8A8A';
            t.done = dn; t.tickBg = t.on ? '#050505' : '#FFE45C'; t.tickFg = t.on ? '#FFE45C' : '#050505';
            t.aria = dn ? 'completed' : 'not completed yet';
          });
        });
      }
      if (v.show.learn && les && les.tabs) {
        var over = (this.ss.unitContent || {})[les.id] || {};
        var src = {
          watch: over.watch || (les.tabs.watch && les.tabs.watch.src) || '',
          play: over.play || (les.tabs.play && les.tabs.play.src) || '',
          read: over.read || (les.tabs.read && les.tabs.read.src) || ''
        };
        var STEPS = [['watch', 'Watch'], ['play', 'Play'], ['read', 'Read']];
        var tabState = S.ssTab || {}, tab = tabState[les.id] || 'watch';
        var ti = Math.max(0, STEPS.findIndex(function (x) { return x[0] === tab; }));
        var sd = S.stepDone || {}, lkey = CO.id + '-' + S.mod + '-' + S.les;
        var setTab = function (t, markDone) {
          self.xpStop();
          self.setState(function (s) {
            var nt = Object.assign({}, s.ssTab); nt[les.id] = t;
            var o = { ssTab: nt };
            if (markDone) { var d = Object.assign({}, s.stepDone || {}); d[lkey + ':' + STEPS[ti][0]] = true; o.stepDone = d; }
            return o;
          });
        };
        // Step bar at the top (the portal's own "1 Watch → 2 Read → 3 Try" bar, re-labelled)
        v.cur.hasSteps = true;
        v.cur.steps = STEPS.map(function (st, i) {
          var on = i === ti, dn = !!sd[lkey + ':' + st[0]] && !on;
          return { name: st[1], arrow: i > 0, cur: on, line: i <= ti ? '#FFE45C' : '#333333', mark: dn ? '✓' : String(i + 1),
            ring: on ? '#FFE45C' : dn ? '#5E5E5E' : '#333333', bg: on ? 'rgba(255,228,92,.12)' : 'transparent', fg: on ? '#FFE45C' : dn ? '#EDEDED' : '#8A8A8A',
            dotBg: on || dn ? '#FFE45C' : '#262626', dotFg: on || dn ? '#050505' : '#8A8A8A', go: function () { setTab(st[0]); } };
        });
        // Content for the current step
        v.xpShow = false; v.recShow = true; v.recAvail = false;
        if (tab === 'watch') {
          if (src.watch) { this._ssVidUnit = this._ssVidUnit || {}; this._ssVidUnit[src.watch] = les.id; }
          v.wt = Object.assign({}, v.wt, { isVideo: !!src.watch, isSlides: false, src: src.watch, title: les.title, groups: [], tall: false,
            vw: portrait ? 'min(100%, 440px)' : '100%', aspect: portrait ? '9 / 16' : '16 / 9', ref: src.watch ? this.ssVideoRef(src.watch) : null });
        } else {
          v.wt = Object.assign({}, v.wt, { isVideo: false, isSlides: !!src[tab], src: src[tab], title: les.title, groups: [], tall: true, ref: null });
        }
        // A step without a file shows the "Will be updated soon" card.
        if (!src[tab]) {
          var other = STEPS.filter(function (x) { return x[0] !== tab && src[x[0]]; }).map(function (x) { return x[1] === 'Watch' ? 'watch the video' : x[1] === 'Play' ? 'play the game' : 'read the notes'; });
          v.ss_soon = { on: true, kicker: '~/' + tab,
            text: (tab === 'watch' ? 'The video' : tab === 'play' ? 'The game' : 'The reading material') + ' for this topic is on its way.' +
              (other.length ? ' For now, ' + other.join(' and ') + '.' : ' Check back soon!') };
        }
        // Play and Read open full screen (the game or notes frame only); browsers without it get a new tab.
        if ((tab === 'play' || tab === 'read') && src[tab]) {
          var fsUrl = src[tab];
          v.ss_fs = { on: true, label: 'Full screen', hint: tab === 'play' ? 'Press Esc to leave full screen' : 'Read in full screen · Esc to leave',
            go: function () {
              var el = document.getElementById('ss-embed');
              var rq = el && (el.requestFullscreen || el.webkitRequestFullscreen);
              var tab2 = function () { window.open(fsUrl, '_blank', 'noopener'); };
              if (!rq) return tab2();
              try { var p = rq.call(el); if (p && p.catch) p.catch(tab2); } catch (e) { tab2(); }
            } };
        }
        // Bottom bar: "Next: Play →" / "Next: Read →", then the next unit
        var nextStep = STEPS[ti + 1], baseGo = v.cur.stepGo, baseHint = String(v.cur.stepHint || '').replace(/^Step \d+ of \d+ · /, '');
        v.cur.stepHint = 'Step ' + (ti + 1) + ' of 3 · ' + baseHint;
        if (nextStep) {
          v.cur.stepLabel = 'Next: ' + nextStep[1] + ' →';
          v.cur.stepGo = function () { setTab(nextStep[0], true); };
        } else {
          v.cur.stepGo = function (e) {
            self.setState(function (s) { var d = Object.assign({}, s.stepDone || {}); d[lkey + ':read'] = true; return { stepDone: d }; });
            if (baseGo) baseGo(e);
          };
        }
        // "← Previous": previous step, or the previous unit (opening on its last step)
        if (ti > 0) unitsPrev = { on: true, label: '← ' + STEPS[ti - 1][1], go: function () { setTab(STEPS[ti - 1][0]); } };
        else if (v.cur.hasPrev) unitsPrev = { on: true, label: '← Previous', go: function () {
          var flat = []; CO.modules.forEach(function (m, mi) { m.lessons.forEach(function (l, li) { flat.push({ mi: mi, li: li, l: l }); }); });
          var idx = flat.findIndex(function (f) { return f.mi === S.mod && f.li === S.les; }), pv = flat[idx - 1];
          if (pv && pv.l.tabs) self.setState(function (s) { var nt = Object.assign({}, s.ssTab); nt[pv.l.id] = 'read'; return { ssTab: nt }; });
          v.cur.prev();
        } };
      } else if (v.show.learn && v.cur && v.cur.hasPrev) {
        unitsPrev = { on: true, label: '← Previous', go: function () { v.cur.prev(); } };
      }

      var first = String(U.name || '').trim().split(/\s+/)[0];
      if (v.today && first) v.today.hello = 'Hi ' + first + ' · ' + v.today.hello;

      if (this.ssProctorActive()) {
        var stay = function () { self.ssToast('Finish and submit the Sprint first. Leaving the test is not allowed while it runs.', true); };
        Object.keys(v.nav).forEach(function (k) {
          if (k === 'test') return;
          if (typeof v.nav[k] === 'function') v.nav[k] = stay; else if (v.nav[k] && v.nav[k].go) v.nav[k] = Object.assign({}, v.nav[k], { go: stay });
        });
      }

      v.lb = this.ssBoardVals();
      v.ss = {
        when: when,
        prev: unitsPrev || { on: false, label: '', go: null },
        soon: v.ss_soon || { on: false, kicker: '', text: '' },
        next: (function () {
          var N = self.ss.nextSprint, open = !S.ssNextFolded;
          if (!N || !Array.isArray(N.groups) || !N.groups.length) return { on: false };
          return { on: true, title: N.title, when: when.line + ' · ' + when.dur, open: open, toggleLabel: open ? 'Hide' : 'Show topics',
            toggle: function () { self.setState(function (s) { return { ssNextFolded: !s.ssNextFolded }; }); },
            groups: N.groups.map(function (g) { return { name: g.name, topics: g.topics.map(function (t) { return { t: t }; }) }; }) };
        })(),
        fs: v.ss_fs || { on: false, label: '', hint: '', go: null },
        user: {
          name: U.name || (U.kind === 'admin' ? U.email : U.rollNo),
          sub: U.kind === 'admin' ? (U.role === 'super_admin' ? 'super admin' : 'admin') + ' · preview' : U.rollNo + (U.batch ? ' · ' + U.batch : ''),
          isAdmin: U.kind === 'admin',
          hasPhoto: U.kind === 'student' && !!U.photoAt,
          photo: U.photoAt ? '/api/me/photo?v=' + U.photoAt : '',
          changePhoto: function () {
            if (self.ssProctorActive()) { self.ssToast('Finish and submit the Sprint first.', true); return; }
            pickPhoto().then(function (d) { return api('PUT', '/api/me/photo', { photo: d }); }).then(function (r) {
              U.photoAt = r.photoAt; self.setState({ ssPhotoAt: r.photoAt }); self.ssToast('Photo updated.');
            }, function (e) { if (e && e.message) self.ssToast(e.message, true); });
          }
        },
        logout: function () {
          if (self.ssProctorActive() && !confirm('The Sprint is still running. If you log out, the timer keeps running. Log out anyway?')) return;
          self.ssSaveProgress(true); self.ssSaveDraft(true);
          if (U.kind === 'admin') { location.href = '/admin'; return; }
          api('POST', '/api/auth/logout').then(function () { location.href = '/login'; }, function () { location.href = '/login'; });
        },
        toAdmin: function () { location.href = '/admin'; },
        // The guide opens in a new tab; during a proctored test that would count as leaving the test.
        help: function () {
          if (self.ssProctorActive()) { self.ssToast('Help is closed while the test runs. Finish and submit first.', true); return; }
          window.open('/help', '_blank', 'noopener');
        },
        banner: { on: U.kind === 'admin', text: self.ss.sprint.previewOf
          ? 'Admin preview of Sprint "' + self.ss.sprint.previewOf + '" (not the live Sprint). The test opens any time and is never ranked. Change it in Admin → Sprint questions.'
          : 'Admin preview: you are viewing the student portal. The test opens any time and your attempts are never ranked.' },
        again: { on: U.kind === 'admin' && !!R, text: 'Admin preview: start a fresh attempt with the same questions (this result is discarded).',
          go: function () {
            if (!confirm('Discard this preview attempt and start the test again?')) return;
            api('POST', '/api/sprint/restart').then(function () { location.reload(); }, function (e) { self.ssToast(e.message, true); });
          } },
        toast: { on: !!S.ssToast, text: S.ssToast ? S.ssToast.text : '', ring: S.ssToast && S.ssToast.err ? '#FF7A7A' : '#9BE58B' },
        submit: { pending: !!S.ssSubmitting || (!!v.t.done && !R && !S.ssSubmitErr), failed: !!S.ssSubmitErr && !R, error: S.ssSubmitErr || '', retry: function () { self._ssRetryAt = 0; self.gradeTest(); } },
        review: (function () {
          var mode = self.ss.sprint.reviewMode || 'after_close', admin = U.kind === 'admin';
          if (!R || (mode === 'hidden' && !admin)) return { on: false, text: '', label: '', open: null };
          var waiting = !admin && mode === 'after_close' && Date.now() + clock.offset < self.ss.sprint.closeMs;
          return { on: true, label: waiting ? 'Open review page' : 'Review my answers',
            text: waiting ? 'Your answers review opens when the Sprint closes at ' + when.close + ' IST: each question with the correct answer, and your score per unit.'
              : 'See each question with your answer and the correct one, and your score per unit.',
            open: function () { window.open('/review', '_blank', 'noopener'); } };
        })(),
        result: {
          on: !!R, score: R ? fmtScore(R.score) + ' / ' + fmtScore(R.maxTotal) : '',
          note: R ? (R.endedByViolations ? 'Submitted automatically: too many proctoring violations.' : R.textPending ? 'Written problems are marked by the panel. Your total and rank update when marks are added.' : R.autoSubmitted ? 'Auto-submitted when time ran out.' : 'All parts marked.') : ''
        }
      };
      return v;
    }
  }

  // Feedback goes to the server (the portal also keeps its local copy).
  var baseSave = Component.prototype.saveFeedback;
  SprintPortal.prototype.saveFeedback = function (rec) {
    api('POST', '/api/feedback', rec).catch(function () {});
    try { return baseSave.call(this, rec); } catch (e) { return undefined; }
  };

  function fail(msg) {
    var app = document.getElementById('app');
    app.innerHTML = '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0A0A0A;color:#EDEDED;font-family:JetBrains Mono,monospace;padding:24px">' +
      '<div style="max-width:520px;display:flex;flex-direction:column;gap:14px"><div style="font-family:VT323,monospace;font-size:20px;color:#FF7A7A">error</div>' +
      '<div style="font-size:20px;font-weight:800">Could not load the portal</div><div style="color:#BDBDBD"></div>' +
      '<button onclick="location.reload()" style="align-self:flex-start;min-height:46px;padding:0 20px;border:0;border-radius:12px;background:#FFE45C;color:#050505;font-weight:800;font-size:16px;cursor:pointer">Try again</button></div></div>';
    app.querySelector('div div div:nth-child(3)').textContent = msg;
  }

  // Opens the file chooser; resolves with a small JPEG data URL (public/photo.js), rejects if nothing usable was chosen.
  function pickPhoto() {
    return new Promise(function (resolve, reject) {
      var inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*';
      inp.onchange = function () { window.SSPhoto.fromFile(inp.files[0]).then(resolve, reject); };
      inp.click();
    });
  }

  // Every student needs a photograph. Accounts without one (simple log-in, or registered before photos were
  // asked for) add it here before the portal opens. Skipped while a Sprint attempt is running.
  function photoGate(B, done) {
    var app = document.getElementById('app'), data = '';
    app.innerHTML = '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0A0A0A;color:#EDEDED;font-family:JetBrains Mono,monospace;padding:24px;box-sizing:border-box">' +
      '<div style="width:100%;max-width:520px;display:flex;flex-direction:column;gap:18px;background:#151515;border-radius:22px;padding:28px;box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 24px 48px -20px rgba(0,0,0,.9)">' +
      '<div style="font-family:VT323,monospace;font-size:20px;color:#FFE45C">~/profile/photo</div>' +
      '<div style="font-family:Silkscreen,monospace;font-size:28px;line-height:1.1;color:#FFFFFF">Add your photograph</div>' +
      '<div data-k="hello" style="font-size:15px;line-height:1.55;color:#BDBDBD"></div>' +
      '<div style="display:flex;align-items:center;gap:16px"><div data-k="prev" style="width:112px;height:112px;flex-shrink:0;border-radius:16px;border:2px dashed #333333;background:#050505;display:flex;align-items:center;justify-content:center;overflow:hidden;color:#5E5E5E;font-size:12px">no photo</div>' +
      '<button data-k="choose" type="button" style="min-height:46px;padding:0 18px;border:2px solid #333333;border-radius:12px;background:transparent;color:#FFFFFF;font-family:inherit;font-size:15px;font-weight:800;cursor:pointer">Choose a photo</button></div>' +
      '<div data-k="msg" role="alert" style="display:none;padding:10px 14px;border-radius:12px;border:2px solid #FF7A7A;color:#FF7A7A;font-size:14px;font-weight:700"></div>' +
      '<button data-k="save" type="button" disabled style="min-height:50px;border:0;border-radius:14px;background:#262626;color:#8A8A8A;font-family:inherit;font-size:16px;font-weight:800;cursor:not-allowed">Save and open the portal</button>' +
      '<button data-k="out" type="button" style="align-self:flex-start;border:0;background:none;color:#8A8A8A;font-family:inherit;font-size:14px;font-weight:700;text-decoration:underline;cursor:pointer;padding:0">Log out</button>' +
      '</div></div>';
    var $ = function (k) { return app.querySelector('[data-k="' + k + '"]'); };
    var first = String(B.user.name || '').trim().split(/\s+/)[0];
    $('hello').textContent = (first ? 'Hi ' + first + '. ' : '') + 'Add a clear, recent photo of your face. It appears on your profile and helps mentors recognise you. You can change it later by clicking it in the sidebar.';
    var say = function (t) { var m = $('msg'); m.textContent = t || ''; m.style.display = t ? 'block' : 'none'; };
    var ready = function (on) { var b = $('save'); b.disabled = !on; b.style.background = on ? '#FFE45C' : '#262626'; b.style.color = on ? '#050505' : '#8A8A8A'; b.style.cursor = on ? 'pointer' : 'not-allowed'; };
    $('choose').onclick = function () {
      pickPhoto().then(function (d) {
        data = d; say('');
        var img = document.createElement('img'); img.src = d; img.alt = 'Your photo'; img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
        var p = $('prev'); p.replaceChildren(img); p.style.border = '2px solid #FFE45C';
        $('choose').textContent = 'Change photo'; ready(true);
      }, function (e) { say(e.message); });
    };
    $('save').onclick = function () {
      if (!data) return;
      ready(false); $('save').textContent = 'Saving…';
      api('PUT', '/api/me/photo', { photo: data }).then(function (r) { B.user.photoAt = r.photoAt; app.innerHTML = ''; done(); },
        function (e) { say(e.message); ready(true); $('save').textContent = 'Save and open the portal'; });
    };
    $('out').onclick = function () { api('POST', '/api/auth/logout').then(function () { location.href = '/login'; }, function () { location.href = '/login'; }); };
  }

  api('GET', '/api/bootstrap').then(function (B) {
    clock.offset = B.serverNow - Date.now();
    window.__ssBoot = B;
    var boot = function () { bootPortal(SprintPortal, { testMode: B.sprint.preview ? 'preview-open' : 'auto' }); };
    var testRunning = B.attempt && B.attempt.status === 'running';
    if (B.user.kind === 'student' && !B.user.photoAt && !testRunning && window.SSPhoto) photoGate(B, boot); else boot();
  }, function (e) { if (e.code !== 'AUTH') fail(e.message); });
})();
