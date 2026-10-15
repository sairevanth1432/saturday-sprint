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
  var PROGRESS_KEYS = ['done', 'solved', 'pPick', 'pSel', 'course', 'pc', 'pcSet', 'ssTab', 'stepDone', 'stepDoneById', 'ssHqPick', 'ssVidSeen'];

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
  // Answers to the post-test questions on AI use (same list on the server: index.js AI_LEVELS).
  var AI_LEVELS = ['I did not use AI', 'I used AI for minor help/hints', 'I used AI for some questions', 'I used AI for most questions', 'I relied heavily on AI to complete the Sprint'];
  // Watermark: the NIAT ID as zero-width characters (8 bits per character, U+200B = 0, U+200C = 1) between two
  // U+2060 markers. Admin → Integrity flags decodes it from leaked text.
  var zwEncode = function (s) {
    var out = '\u2060';
    String(s || '').split('').forEach(function (ch) { var b = ch.charCodeAt(0) & 255; for (var i = 7; i >= 0; i--) out += (b >> i) & 1 ? '\u200C' : '\u200B'; });
    return out + '\u2060';
  };
  // Scrambles copied question text so AI models cannot read it reliably (see the 'copy' listener in ssHpListen).
  var HOMO = { a: '\u0430', c: '\u0441', e: '\u0435', i: '\u0456', o: '\u043E', p: '\u0440', x: '\u0445', y: '\u0443', A: '\u0410', B: '\u0412', C: '\u0421', E: '\u0415', H: '\u041D', K: '\u041A', M: '\u041C', O: '\u041E', P: '\u0420', T: '\u0422', X: '\u0425' };
  var scrambleText = function (text) {
    return String(text || '').replace(/[A-Za-z0-9]+/g, function (w) {
      var ch = w.split('');
      if (ch.length > 3) { // shuffle the inside letters
        var mid = ch.slice(1, -1);
        for (var i = mid.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = mid[i]; mid[i] = mid[j]; mid[j] = t; }
        ch = [ch[0]].concat(mid, [ch[ch.length - 1]]);
      }
      return ch.map(function (c) {
        if (/[0-9]/.test(c)) return String((Number(c) + 3 + Math.floor(Math.random() * 6)) % 10); // numbers change too
        return HOMO[c] && Math.random() < 0.6 ? HOMO[c] : c;
      }).join('\u200B');
    });
  };
  var fmtScore = function (x) { return x == null ? '–' : String(Math.round(Number(x) * 100) / 100); };

  function placeholders(types) {
    return (types || []).map(function (t) {
      if (t.type === 'mcq') return { course: t.course, type: 'mcq', q: '', o: [], c: -1 };
      if (t.type === 'code') return { course: t.course, type: 'code', q: '', starter: '', sample: ['', ''], tests: [] };
      return { course: t.course, type: 'text', q: '' };
    });
  }
  // The Sprint test cannot be taken on a phone (tablets are allowed). Same rule as isPhone() in index.js.
  function ssIsPhone() {
    try { if (navigator.userAgentData && navigator.userAgentData.mobile) return true; } catch (e) {}
    return /iPhone|iPod|Android.+Mobile|Windows Phone|IEMobile|Opera Mini|BlackBerry/i.test(navigator.userAgent || '');
  }
  // The student's own question and option order (sprint.js attemptOrder): position on screen → original numbering.
  // Answers go to the server in the original numbering, so the order only changes what the student sees.
  var ORD = null;
  var origQ = function (i) { return ORD ? ORD.order[Number(i)] : Number(i); };
  var origOpt = function (k, v) { var p = ORD && ORD.optOrder[k]; return p ? p[v] : v; };
  var shownOpt = function (k, v) { var p = ORD && ORD.optOrder[k]; return p ? p.indexOf(v) : v; };
  var shownKeys = function (obj) { var out = {}; Object.keys(obj || {}).forEach(function (k) { out[ORD ? ORD.order.indexOf(Number(k)) : k] = obj[k]; }); return out; };
  function fromServer(qs, a) {
    ORD = a && Array.isArray(a.order) && a.order.length === qs.length ? { order: a.order, optOrder: a.optOrder || [] } : null;
    if (ORD) qs = ORD.order.map(function (k) { var q = qs[k], p = ORD.optOrder[k]; return p && q.o ? Object.assign({}, q, { o: p.map(function (j) { return q.o[j]; }) }) : q; });
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
    var at = function (k) { return ORD ? ORD.order.indexOf(Number(k)) : k; };
    Object.keys(d.mcq || {}).forEach(function (k) { s.tAns[at(k)] = shownOpt(Number(k), d.mcq[k]); });
    Object.keys(d.text || {}).forEach(function (k) { s.tText[at(k)] = d.text[k]; });
    Object.keys(d.code || {}).forEach(function (k) { s.code['t' + at(k)] = d.code[k]; });
    return s;
  }

  // Class declared by the portal script (global lexical binding).
  /* global Component, bootPortal */
  class SprintPortal extends Component {
    constructor() {
      super();
      var B = window.__ssBoot, S = this.state;
      this.ss = B;
      S.ssPhone = B.user.kind === 'student' && (!!B.phoneBlocked || ssIsPhone());
      this.OPEN = toLocal(B.sprint.openMs);
      this.CLOSE = toLocal(B.sprint.closeMs);
      this.DUR = B.sprint.durMs;
      this.test = placeholders(B.sprint.types);
      // Sound cues (practice right/wrong, the starting gun, the last 10 s, streak) are remembered per browser.
      try { if (localStorage.getItem('ss-snd2') === '0') S.snd = false; } catch (e) {}
      S.ssTopicsOpen = false; S.ssFocus = false; S.ssMenu = ''; S.ssMusicOn = false;

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
        if (f && !self[f].some(function (m) { return m._pack && m.name === u.name; })) self[f].push({ name: u.name, color: u.color, lessons: u.lessons, practiceTopic: u.practiceTopic || '', _pack: true });
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
        // steps of lessons that were removed are kept by lesson id (stepDoneById), never dropped (Admin analytics)
        var kept = Object.assign({}, p.stepDoneById);
        var remap = function (obj, isStep) {
          var out = {};
          Object.keys(obj || {}).forEach(function (k) {
            var m = /^([^:]+)(:.*)?$/.exec(k), was = m && oldPos[m[1]], at = was && newPos[was];
            if (at && obj[k]) out[at + (m[2] || '')] = obj[k];
            else if (!at && was && obj[k] && isStep && m[2]) kept[was.split('/')[1] + m[2]] = true;
          });
          return out;
        };
        p = Object.assign({}, p, { done: remap(p.done), stepDone: remap(p.stepDone, true), stepDoneById: kept });
        sameContent = true;
      }
      PROGRESS_KEYS.forEach(function (k) { if (p[k] !== undefined && (k !== 'done' || sameContent)) S[k] = p[k]; });
      if (moved) { S.course = 0; S.mod = 0; S.les = 0; }
      if (p.code) S.code = Object.assign({}, S.code, p.code);
      // Practice questions added in Admin → Practice questions, after the built-in ones. MCQ answers are stored by
      // position (practice ++ ccbpQuiz ++ genaiQuiz), so they always go at the very end and archived ones stay as
      // placeholders that Practice never shows (no course).
      var PX = B.practiceExtra || {};
      if (Array.isArray(PX.mcq) && PX.mcq.length) this.genaiQuiz = this.genaiQuiz.concat(PX.mcq);
      if (Array.isArray(PX.code) && PX.code.length) this.ccbpCoding = this.ccbpCoding.concat(PX.code);
      this.ssPracticeFollowsLearn();
      // Video likes: my likes and the counts per topic.
      var LK = B.likes || {};
      S.ssLiked = {}; (LK.mine || []).forEach(function (id) { S.ssLiked[id] = true; });
      S.ssLikeN = Object.assign({}, LK.counts || {});
      this.ssHpListen();

      var a = B.attempt;
      if (a && a.status === 'running' && S.ssPhone) {
        S.tab = 'test'; // shows the "use a laptop" card; the server sent no questions
      } else if (a && a.status === 'running') {
        this.test = fromServer(a.questions, a);
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
      this.ssLoadJourney();
      // Deep links: /#profile, /#practice, /#learn, /#board open that tab (not during a proctored test).
      var hashTab = location.hash.slice(1);
      if (['profile', 'practice', 'learn', 'board', 'home'].indexOf(hashTab) >= 0 && !this.ssProctorActive()) this.setState({ tab: hashTab });
      if (hashTab === 'hiring' && !this.ssProctorActive()) this.setState({ tab: 'practice', ssPHire: true });
      // Web Audio may only start after a user gesture: the first click or key wakes the engine and plays any waiting cue.
      var wake = function () { self._ssGesture = true; try { self.au(); } catch (e) {} if (self._ssCueQ) { var k = self._ssCueQ; self._ssCueQ = null; self.ssCue(k); } };
      document.addEventListener('pointerdown', wake, { once: true, capture: true });
      // Esc (or the browser) leaving full screen also leaves focus mode; a click outside a menu closes it.
      document.addEventListener('fullscreenchange', function () { if (!document.fullscreenElement && self.state.ssFocus) self.setState({ ssFocus: false }); });
      document.addEventListener('pointerdown', function (e) { if (self.state.ssMenu && !(e.target.closest && e.target.closest('.ss-menu-wrap'))) self.setState({ ssMenu: '' }); }, true);
      // Background music: a lo-fi chiptune loop (public/music/lofi-loop.wav), off until the student turns it on; remembered per browser.
      // Music is on by default (it can only start after the first click); unticking it in the horn menu is remembered.
      try { if (localStorage.getItem('ss-music') !== '0') { var m0 = function () { self.ssMusic(true); }; document.addEventListener('pointerdown', m0, { once: true, capture: true }); } } catch (e) {}
      document.addEventListener('keydown', wake, { once: true, capture: true });
      this.ssProctorMount();
      this.ssActMount();
    }

    // ---------- persistence
    ssProgress() {
      var S = this.state, out = {};
      PROGRESS_KEYS.forEach(function (k) { if (S[k] !== undefined) out[k] = S[k]; });
      out.cv = this._ssContentV;
      // finished steps by lesson id ("tp-forloop:watch"), merged and never trimmed: survives topics being moved or removed
      var byId = Object.assign({}, S.stepDoneById), CLp = this.courseList();
      Object.keys(S.stepDone || {}).forEach(function (k) {
        var m = /^([a-z]+)-(\d+)-(\d+):(\w+)$/.exec(k);
        if (!m || !S.stepDone[k]) return;
        var c = CLp.find(function (x) { return x.id === m[1]; }), mod = c && c.modules[Number(m[2])], l = mod && mod.lessons[Number(m[3])];
        if (l) byId[l.id + ':' + m[4]] = true;
      });
      out.stepDoneById = byId;
      out.code = {};
      Object.keys(S.code || {}).forEach(function (k) { if (!/^t\d+$/.test(k)) out.code[k] = S.code[k]; });
      return out;
    }
    ssSaveProgress(beacon) {
      if (this.ss.user.kind !== 'student') return;
      var json = JSON.stringify(this.ssProgress());
      if (json === this._ssLast.progress) return;
      var self = this;
      api('PUT', '/api/progress', { data: JSON.parse(json) }, { keepalive: !!beacon }).then(function () { self._ssLast.progress = json; if (!beacon) self.ssLoadJourney(); }, function () {});
    }
    ssAnswers() {
      var S = this.state, out = { mcq: {}, text: {}, code: {} };
      this.test.forEach(function (q, i) {
        var k = origQ(i);
        if (q.type === 'mcq' && S.tAns[i] !== undefined) out.mcq[k] = origOpt(k, S.tAns[i]);
        else if (q.type === 'text' && S.tText[i]) out.text[k] = S.tText[i];
        else if (q.type === 'code' && S.code['t' + i] !== undefined) out.code[k] = S.code['t' + i];
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
        self.test = fromServer(a.questions, a);
        var d = draftToState(a.draft);
        self.setState(function (s) {
          return { tStart: toLocal(a.startedAt), now: Date.now(), tCur: 0, tAns: d.tAns, tText: d.tText, code: Object.assign({}, s.code, d.code) };
        });
      }, function (e) {
        if (e.code === 'PHONE_BLOCKED') { self.setState({ ssPhone: true }); return; }
        self.ssToast(e.message, true);
        if (e.code === 'ALREADY_SUBMITTED') setTimeout(function () { location.reload(); }, 1500);
      }).then(function () { self._ssStarting = false; });
    }
    ssCheck(index, key) {
      var self = this, q = this.test[index];
      var code = this.state.code[key] !== undefined ? this.state.code[key] : q.starter;
      this.setState(function (s) { var c = Object.assign({}, s.ctests); c[key] = 'running'; return { ctests: c }; });
      api('POST', '/api/sprint/check', { index: origQ(index), code: code }).then(function (r) {
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
        self.setState({ tGraded: true, tDone: true, ssSubmitting: false, tDoneAt: toLocal(a.submittedAt), ssResult: a.result, tCodeRes: shownKeys(a.result.codeRes) });
        self.ssLoadBoard(true);
        self.ssLoadJourney();
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
        if (isFinite(el.duration) && el.duration > 0) {
          // a topic with several videos: progress is the average over its videos (each counted up to its furthest point)
          var pos = (self._ssVidList || {})[cur] || { i: 0, n: 1 }, p = Math.min(100, t / el.duration * 100 + (el.ended ? 100 : 0));
          var VP = self._ssVidPct || (self._ssVidPct = {}), vp = VP[unit] || (VP[unit] = {}); // kept across activity flushes
          vp[pos.i] = Math.max(vp[pos.i] || 0, p);
          var sum = 0; for (var k in vp) sum += vp[k];
          row.videoPct = Math.max(row.videoPct, sum / pos.n);
        }
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
      this.setState({ tGraded: true, tDone: true, ssSubmitting: false, tDoneAt: toLocal(a.submittedAt), ssResult: a.result, tCodeRes: shownKeys(a.result.codeRes) });
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
      api('GET', '/api/leaderboard?limit=100' + (this.state.ssBoardSprint ? '&sprint=' + encodeURIComponent(this.state.ssBoardSprint) : '')).then(function (b) {
        self.setState({ ssBoard: b, ssBoardAt: Date.now() });
      }, function () {}).then(function () { self._ssBoardBusy = false; });
    }

    // ---------- the race: completion vs the cohort, streak, medals (GET /api/journey → server/journey.js)
    ssLoadJourney() {
      if (this._ssJrBusy) return;
      this._ssJrBusy = true;
      var self = this;
      api('GET', '/api/journey').then(function (j) {
        self.setState({ ssJourney: j, ssJourneyAt: Date.now() });
        self.ssStreakCue(j);
      }, function () {}).then(function () { self._ssJrBusy = false; });
    }
    // One chime when today's activity made the streak longer (remembered per student in this browser).
    ssStreakCue(j) {
      if (!j || !j.streak || !j.streak.today || this.ss.user.kind !== 'student') return;
      var k = 'ss-streak-' + this.ss.user.rollNo, prev = 0;
      try { prev = Number(localStorage.getItem(k)) || 0; } catch (e) {}
      if (j.streak.days > prev) this.ssCue('quiz');
      try { localStorage.setItem(k, String(j.streak.days)); } catch (e) {}
    }
    // Sound cues reuse the portal's own Web Audio engine (au/sfx, also used by the explainers). Browsers only start
    // audio after a user gesture, so a cue that comes earlier waits for the first click or key.
    ssCue(kind) {
      if (this.state.snd === false) return;
      if (!this._ssGesture) { this._ssCueQ = kind; return; }
      try { this.au(); this.sfx(kind); } catch (e) {}
    }
    // Values for the Profile page (template: PROFILE_TAB in build-portal.js): photo, streak, medals with a short "how to earn".
    ssProfileVals(v) {
      var J = this.state.ssJourney, U = this.ss.user, self = this;
      var st = (J && J.streak) || { days: 0, today: false, best: 0 };
      var streakLabel = st.days >= 2 ? 'Day ' + st.days + ' on the track' : st.days === 1 ? (st.today ? 'Day 1 on the track' : 'Back on the track today?') : 'Lace up: first lap today';
      var badges = ((J && J.badges) || []).map(function (b) {
        return { id: b.id, name: b.name, hint: b.earned ? 'Earned' : b.desc, earned: !!b.earned, title: b.name + ': ' + b.desc,
          bg: b.earned ? '#FFE45C' : '#0D0D0D', fg: b.earned ? '#050505' : '#5E5E5E', ring: b.earned ? '#FFE45C' : '#262626', hintFg: b.earned ? '#FFE45C' : '#8A8A8A', opacity: b.earned ? '1' : '.85' };
      });
      var n = badges.filter(function (b) { return b.earned; }).length;
      return {
        name: U.name || (U.kind === 'admin' ? U.email : U.rollNo), sub: U.kind === 'admin' ? 'admin preview' : U.rollNo + (U.batch ? ' · ' + U.batch : ''),
        hasPhoto: U.kind === 'student' && !!U.photoAt, noPhoto: !(U.kind === 'student' && !!U.photoAt), photo: U.photoAt ? '/api/me/photo?v=' + U.photoAt : '',
        initial: String(U.name || '?').trim().charAt(0).toUpperCase(), canPhoto: U.kind === 'student',
        changePhoto: function () { v.ss.user.changePhoto(); },
        streakLabel: streakLabel, streakFg: st.today ? '#FFE45C' : '#8A8A8A', streakTitle: 'Active days in a row · best ' + (st.best || 0),
        badges: badges, earned: J ? n + ' of ' + badges.length + ' earned' : 'loading…'
      };
    }
    // ---------- layout: focus mode (Practice full screen, sidebar minimised), menus, music, the Home topic map
    ssFocus(on) {
      var self = this;
      this.setState({ ssFocus: !!on, ssMenu: '' });
      try {
        if (on && !document.fullscreenElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function () {});
        else if (!on && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {});
      } catch (e) {}
    }
    ssMusic(on) {
      var a = this._ssAudio;
      if (!a) { a = this._ssAudio = new Audio('/music/lofi-loop.wav'); a.loop = true; a.volume = 0.22; a.preload = 'auto'; }
      if (on) a.play().catch(function () {}); else a.pause();
      this.setState({ ssMusicOn: !!on });
      try { localStorage.setItem('ss-music', on ? '1' : '0'); } catch (e) {}
    }
    // Every topic in order (course by course): the sidebar list and the Home map share it.
    ssTopicItems(v) {
      var self = this, S = this.state, items = [];
      (v.lgroups || []).forEach(function (g, ci) {
        (g.topics || []).forEach(function (t, mi) {
          var mod = ((self.courseList()[ci] || {}).modules || [])[mi] || {};
          items.push({ name: t.name, practiceTopic: mod.practiceTopic || '', course: g.name, done: !!t.done, soon: !!t.soon, cur: !!t.on && S.tab === 'learn',
            go: function () {
              if (self.ssProctorActive()) { self.ssToast('Finish and submit the Sprint first.', true); return; }
              // On Practice, a topic in the sidebar switches the practice topic (the page has no Topics button); elsewhere it opens the lesson.
              if (self.state.tab === 'practice' && v.pq && Array.isArray(v.pq.groups)) {
                var k = function (x) { return String(x || '').toLowerCase().replace(/&/g, ' and ').replace(/\bpart\s*-?\s*\d+\b/g, '').replace(/[^a-z0-9]+/g, '').replace(/s$/, ''); };
                var part = function (x) { var m = /\bpart\s*-?\s*(\d+)\b/i.exec(String(x || '')); return m ? m[1] : ''; };
                // same name, and the same Part number when both names have one ("… Part 1" is not "… Part 2")
                var same = function (a, b) { return !!a && k(a) === k(b) && (!part(a) || !part(b) || part(a) === part(b)); };
                var hit = null;
                var pt = mod.practiceTopic || '';
                v.pq.groups.forEach(function (gr) { (gr.topics || []).forEach(function (tp) { if (!hit && (same(t.name, tp.name) || same(pt, tp.name))) hit = tp; }); });
                if (hit) { hit.go(); self.setState({ ssMenu: '', ssPHire: false, ssHqTopic: null }); return; }
                // no Quiz questions for this topic, but Hiring questions: Practice shows its Hiring tab
                var hname = self.ssHqFind(t.name) ? t.name : self.ssHqFind(pt) ? pt : '';
                if (hname) { self.setState({ ssMenu: '', ssPHire: true, ssHqTopic: { name: hname, course: g.name } }); return; }
              }
              t.go(); self.setState({ tab: 'learn', ssMenu: '' }); } });
        });
      });
      return items;
    }
    ssMapVals(v) {
      var items = this.ssTopicItems(v), U = this.ss.user, self = this;
      if (!items.length) return { on: false, items: [], avatar: {}, trophy: {} };
      var cols = 3, W = 170, H = 56, GX = 26, GY = 44;
      var cur = items.findIndex(function (t) { return !t.done; }); if (cur < 0) cur = items.length;
      var slot = function (i) { var r = Math.floor(i / cols), c = i % cols; if (r % 2) c = cols - 1 - c; return { x: c * (W + GX), y: r * (H + GY) }; };
      items.forEach(function (t, i) {
        var p = slot(i), on = i === cur;
        t.n = i + 1; t.left = p.x + 'px'; t.top = p.y + 'px'; t.on = on; t.cx = p.x + W / 2; t.cy = p.y + H / 2;
        t.bg = t.done ? '#FFE45C' : '#151515'; t.fg = t.done ? '#050505' : on ? '#FFFFFF' : '#8A8A8A'; t.ring = t.done || on ? '#FFE45C' : '#262626';
        t.nBg = t.done ? '#050505' : on ? '#FFE45C' : '#262626'; t.nFg = t.done ? '#FFE45C' : on ? '#050505' : '#8A8A8A';
        t.title = t.name + ' · ' + (t.done ? 'done' : on ? 'you are here' : t.soon ? 'coming soon' : 'ahead on the road');
      });
      var tp = slot(items.length), tr = { x: tp.x + W / 2, y: tp.y + H / 2 };
      var pts = items.map(function (t) { return [t.cx, t.cy]; }).concat([[tr.x, tr.y]]);
      var path = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0] + ' ' + p[1]; }).join(' ');
      var donePath = cur > 0 ? pts.slice(0, Math.min(cur + 1, pts.length)).map(function (p, i) { return (i ? 'L' : 'M') + p[0] + ' ' + p[1]; }).join(' ') : '';
      var rows = Math.floor(items.length / cols) + 1;
      // the avatar stands on the top-right corner of the current block (clear of its label); at the trophy once every topic is done
      var at = cur < items.length ? { x: items[cur].cx + W / 2 - 18, y: items[cur].cy - H / 2 - 6 } : { x: tr.x, y: tr.y - H / 2 - 6 };
      var doneN = items.filter(function (t) { return t.done; }).length;
      return { on: true, items: items, w: (cols * W + (cols - 1) * GX) + 'px', h: (rows * H + (rows - 1) * GY) + 'px', path: path, donePath: donePath,
        trophy: { left: tr.x + 'px', top: tr.y + 'px' },
        avatar: { left: at.x + 'px', top: at.y + 'px', hasPhoto: U.kind === 'student' && !!U.photoAt, noPhoto: !(U.kind === 'student' && !!U.photoAt), photo: U.photoAt ? '/api/me/photo?v=' + U.photoAt : '', initial: String(U.name || '?').trim().charAt(0).toUpperCase() },
        done: doneN + ' of ' + items.length + ' topics', hint: doneN >= items.length ? 'Every topic done. Saturday is the finish line.' : 'Next up: ' + items[cur].name };
    }
    // ---------- Practice "Hiring" tab: interview questions for the topic on screen (GET /api/hiring-questions)
    ssLoadHiring() {
      if (this._ssHqBusy || this.state.ssHiring) return;
      this._ssHqBusy = true;
      var self = this;
      api('GET', '/api/hiring-questions').then(function (d) { self.setState({ ssHiring: d || { topics: [] } }); }, function () {}).then(function () { self._ssHqBusy = false; });
    }
    // ---------- Hiring honeypot (content/integrity.json "hiring"): a hidden line asks an AI to name one WRONG option
    // (the same one every time for a question); copying the question is reported and swapped for another question.
    ssHqTrap(q) {
      var I = this.ss.integrity || {}, U = this.ss.user || {};
      if (!q || !I.enabled || !I.hiring) return null;
      var wrong = q.o.map(function (o, i) { return i; }).filter(function (i) { return i !== q.c; }), h = 0;
      for (var k = 0; k < q.id.length; k++) h = (h * 31 + q.id.charCodeAt(k)) >>> 0;
      var idx = wrong[h % wrong.length], wm = I.watermark ? zwEncode(U.kind === 'student' ? U.rollNo : 'ADMIN-' + (U.email || '')) : '';
      return { idx: idx, line: ' ' + I.hiring.split('{option}').join('ABCDEF'[idx]) + wm + ' ', wm: wm };
    }
    // the question a copied Hiring question is swapped for: another of the same topic, the same one for a student every time
    ssHqDecoyFor(id) {
      var topics = (this.state.ssHiring || {}).topics || [], t = topics.find(function (x) { return x.questions.some(function (q) { return q.id === id; }); });
      var pool = t ? t.questions.filter(function (q) { return q.id !== id && Array.isArray(q.o) && q.o.length > 1; }) : [];
      if (!pool.length) return null;
      var seed = String((this.ss.user || {}).rollNo || '') + id, h = 0;
      for (var i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
      return pool[h % pool.length];
    }
    ssHqEvent(id, body) {
      var I = this.ss.integrity || {};
      if (!I.enabled || !I.hiring || !id) return;
      if (body.event === 'copy') { this._hqCopied = this._hqCopied || {}; this._hqCopied[id] = true; }
      var t = ((this.state.ssHiring || {}).topics || []).find(function (x) { return x.questions.some(function (q) { return q.id === id; }); });
      api('POST', '/api/practice/hiring-event', Object.assign({ qid: id, topic: t ? t.topic : '' }, body)).catch(function () {});
    }
    // Practice topic dropdown (under the Practice title): every topic that has Quiz or Hiring questions, by course.
    // Picking one does what the sidebar topic does on Practice (ssTopicItems).
    ssPracticeTopicVals(v, hqOnly) {
      var self = this, S = this.state, open = S.ssMenu === 'ptopic';
      var k = function (x) { return String(x || '').toLowerCase().replace(/&/g, ' and ').replace(/\bpart\s*-?\s*\d+\b/g, '').replace(/[^a-z0-9]+/g, '').replace(/s$/, ''); };
      var part = function (x) { var m = /\bpart\s*-?\s*(\d+)\b/i.exec(String(x || '')); return m ? m[1] : ''; };
      var same = function (a, b) { return !!a && !!b && k(a) === k(b) && (!part(a) || !part(b) || part(a) === part(b)); };
      var ptopics = [];
      ((v.pq && v.pq.groups) || []).forEach(function (g) { (g.topics || []).forEach(function (t) { ptopics.push(t); }); });
      var cur = v.pq ? v.pq.topicLabel : '', groups = [];
      this.ssTopicItems(v).forEach(function (it) {
        var tp = ptopics.find(function (t) { return same(it.name, t.name) || same(it.practiceTopic, t.name); });
        var nq = tp ? parseInt(String(tp.count), 10) || 0 : 0;
        var hq = self.ssHqFind(it.name) || self.ssHqFind(it.practiceTopic), nh = hq ? hq.questions.length : 0;
        if (!nq && !nh) return; // nothing to practise yet: not listed
        var g = groups.find(function (x) { return x.name === it.course; });
        if (!g) groups.push(g = { name: it.course, items: [] });
        var on = hqOnly ? hqOnly.name === it.name : !!tp && same(cur, tp.name);
        g.items.push({ name: it.name, on: on, count: [nq ? nq + ' quiz' : '', nh ? nh + ' hiring' : ''].filter(Boolean).join(' · '),
          go: function () { self.setState({ ssMenu: '' }); it.go(); } });
      });
      return { open: open, groups: groups, has: groups.length > 0,
        toggle: function () { self.setState(function (s) { return { ssMenu: s.ssMenu === 'ptopic' ? '' : 'ptopic' }; }); } };
    }
    // The Hiring topic for a portal topic name: same words ignoring case, punctuation and "&"/"and"; then also a trailing
    // "s" and "Introduction"/"Intro". A Part number must match ("… Part 1" is not "… Part 2").
    ssHqFind(name) {
      var T = ((this.state.ssHiring || {}).topics) || [];
      if (!name || !T.length) return null;
      var exact = function (s) { return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ''); };
      var loose = function (s) { return exact(String(s || '').replace(/\bintroduction\b/ig, 'intro').replace(/\bpart\s*-?\s*(\d+)\b/ig, 'part$1')).replace(/s(?=part\d|$)/g, ''); };
      var e = exact(name), l = loose(name);
      return T.find(function (t) { return exact(t.topic) === e; }) || T.find(function (t) { return loose(t.topic) === l; }) || null;
    }
    // One MCQ at a time, like the Quiz, made from an interview question (make-hiring-mcq.js). Filter by difficulty;
    // answers are kept per student in ssHqPick (question id → option), saved with the rest of Practice progress.
    ssHiringVals(v) {
      var S = this.state, self = this, H = S.ssHiring, key = function (s) { return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ''); };
      var label = v.pq && v.pq.topicLabel, k = key(label);
      var topic = H ? this.ssHqFind(label) : null;
      var all = topic ? topic.questions.filter(function (q) { return Array.isArray(q.o) && q.o.length > 1; }) : [];
      var on = !!S.ssPHire && !!topic && S.tab === 'practice';
      var LV = { Easy: '#9BE58B', Medium: '#FFE45C', Hard: '#FF7A7A' };
      var picks = S.ssHqPick || {}, lvl = S.ssHqLvl || '';
      var list = lvl ? all.filter(function (q) { return q.difficulty === lvl; }) : all;
      if (lvl && !list.length) { lvl = ''; list = all; }
      var posKey = k + '|' + lvl, qi = Math.min(Math.max(0, (S.ssHqPos || {})[posKey] || 0), Math.max(0, list.length - 1)), q = list[qi];
      var go = function (i) { self.setState(function (s) { var m = Object.assign({}, s.ssHqPos); m[posKey] = i; return { ssHqPos: m }; }); };
      var answered = all.filter(function (x) { return picks[x.id] !== undefined; }), right = answered.filter(function (x) { return picks[x.id] === x.c; });
      var filters = [['', 'All']].concat(['Easy', 'Medium', 'Hard'].map(function (l) { return [l, l]; })).map(function (f) {
        var n = f[0] ? all.filter(function (x) { return x.difficulty === f[0]; }).length : all.length;
        return { label: f[1] + ' ' + n, show: n > 0, pressed: f[0] === lvl, go: function () { self.setState({ ssHqLvl: f[0], ssHqHint: false }); } };
      }).filter(function (f) { return f.show; });
      // pick an option (ssHqSel, this visit only), then "Check answer" records it in ssHqPick
      var pk = q ? picks[q.id] : undefined, shown = pk !== undefined, ok = shown && pk === q.c, sel = q ? (S.ssHqSel || {})[q.id] : undefined;
      var last = qi >= list.length - 1, asked = q ? q.asked || [] : [];
      var trap = q ? this.ssHqTrap(q) : null;
      var check = function () {
        if (sel === undefined) { self.setState({ ssHqHint: true }); return; }
        // after a copy, report the pick: the trap option flags AI_TRAP (the server ignores other picks)
        if (trap && (self._hqCopied || {})[q.id]) self.ssHqEvent(q.id, { event: 'answer', pick: sel, trap: trap.idx, correct: sel === q.c });
        self.setState(function (s) { var m = Object.assign({}, s.ssHqPick); m[q.id] = sel; return { ssHqPick: m, ssHqHint: false }; });
      };
      var nCo = asked.length, qtext = q ? q.q : '', sp = qtext.indexOf(' ');
      if (trap && trap.wm && sp > 0) qtext = qtext.slice(0, sp) + trap.wm + qtext.slice(sp); // NIAT ID watermark after the first word
      return {
        has: !!topic && all.length > 0, n: all.length, on: on, bg: on ? '#FFE45C' : 'transparent', fg: on ? '#050505' : '#BDBDBD',
        cardDisp: on ? 'none' : 'flex', inlineDisp: on ? 'none' : 'inline', barDisp: on ? 'none' : 'block',
        open: function () { self.setState({ ssPHire: true }); },
        empty: on && !all.length, emptyNote: 'No interview questions for this topic yet.',
        has1: on && !!q, filters: filters,
        qn: String(qi + 1), qt: String(list.length), correct: String(right.length),
        pct: (list.length ? Math.round((qi + 1) / list.length * 100) : 0) + '%',
        level: q ? q.difficulty : '', lvlFg: q ? (LV[q.difficulty] || '#BDBDBD') : '#BDBDBD',
        q: qtext, hasCode: !!(q && q.code), code: q ? q.code || '' : '',
        hpQid: q && trap ? 'hq:' + q.id : '', hpTrap: trap ? trap.line : '',
        opts: q ? q.o.map(function (t, i) {
          return { k: 'ABCD'[i] || String(i + 1), t: t,
            st: shown ? (i === q.c ? 'ok' : i === pk ? 'bad' : '') : (i === sel ? 'sel' : ''),
            pick: function () { if (shown) return; self.setState(function (s) { var m = Object.assign({}, s.ssHqSel); m[q.id] = i; return { ssHqSel: m, ssHqHint: false }; }); } };
        }) : [],
        hint: !shown && !!S.ssHqHint, shown: shown, verdict: ok ? 'Correct.' : 'Not quite.', verdictColor: ok ? '#9BE58B' : '#FF7A7A',
        why: q ? (q.why || ('Answer: ' + q.o[q.c])) : '', iq: q ? q.iq || '' : '', hasIq: !!(q && q.iq && q.iq !== q.q),
        // every company that asked it, with the job profile (no "+N more")
        coLine: nCo + (nCo === 1 ? ' company' : ' companies'),
        asked: asked.map(function (a) {
          return { company: a.company, role: a.role || 'Role not given',
            extra: [a.round && a.round !== 'Unspecified' ? a.round : '', a.ctc ? 'Salary ₹' + a.ctc : ''].filter(Boolean).join(' · ') };
        }),
        prev: function () { self.setState({ ssHqHint: false }); go(Math.max(0, qi - 1)); }, prevOff: qi === 0,
        skip: function () { self.setState({ ssHqHint: false }); go(last ? 0 : qi + 1); },
        main: shown ? function () { go(last ? 0 : qi + 1); } : check,
        mainLabel: !shown ? 'Check answer' : last ? 'Back to question 1' : 'Next question →'
      };
    }
    ssBoardVals() {
      var B = this.state.ssBoard, self = this, S = this.state;
      var row = function (r) {
        var top = r.rank <= 3, tone = r.rank === 1 ? '#FFE45C' : r.rank === 2 ? '#EDEDED' : '#FF7A7A';
        return {
          rank: '#' + r.rank, name: r.name, id: r.id, batch: r.university || r.batch || '–', photo: r.photo || '', hasPhoto: !!r.photo, noPhoto: !r.photo, initial: String(r.name || '?').trim().charAt(0).toUpperCase(),
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
      var homeLine = !B ? 'Pacing… fetching the board' : B.hidden ? 'The leaderboard opens after the Sprint.' : me ? 'You are #' + me.rank + ' of ' + B.participants
        : rows.length ? 'Top of the board right now' : 'No results yet. Be the first on the board.';
      return {
        loading: !B, hidden: !!(B && B.hidden), rows: rows, top5: rows.slice(0, 5), top10: rows.slice(0, 10),
        hasRows: rows.length > 0, empty: !!B && rows.length === 0,
        emptyNote: B && B.hidden ? 'The leaderboard is hidden right now. It will appear here once the admins publish it.' : 'The board fills as soon as the first Sprint is submitted. It updates automatically.',
        meRows: me ? [row(me)] : [], meBelow: !!me && !inTop(100), meBelow10: !!me && !inTop(10),
        my: my, participants: B ? B.participants : 0, homeLine: homeLine,
        rule: (B && B.rule) || '', kicker: (B && B.title ? B.title + ' · ' : '') + 'auto-refreshes every 30s',
        updated: S.ssBoardAt ? 'updated ' + new Date(S.ssBoardAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '',
        refresh: function () { self.ssLoadBoard(true); },
        uniLabel: B && B.university ? B.university : '',
        hasSprints: !!(B && B.sprints && B.sprints.length > 1),
        sprints: (B && B.sprints || []).map(function (sp) {
          var on = sp.id === B.sprintId;
          return { label: sp.id.replace(/^sprint-/, 'Sprint ') + (sp.current ? ' · current' : ''), bg: on ? '#FFE45C' : 'transparent', fg: on ? '#050505' : '#FFFFFF',
            go: function () { self.setState({ ssBoardSprint: sp.id }, function () { self.ssLoadBoard(true); }); } };
        })
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
        // the next video of a topic (Up next / a video picked in the list) starts from 0:00, so no cover frame
        if (self._ssAutoPlay === src) { el._ssStarted = true; el.preload = 'auto'; }
        if (!el._ssEndHook) { el._ssEndHook = true; el.addEventListener('ended', function () { self.ssVidEnded(el._src); }); }
        // Many learning bytes open on a black frame. Show a frame from ~3 s in as the cover,
        // and start from 0:00 when the student presses play.
        var cover = function () {
          if (el._src !== src || el._ssStarted || !el.paused || el.currentTime > 0) return;
          var t = Math.min(3, (isFinite(el.duration) ? el.duration : 10) * 0.15);
          el._ssCover = t;
          try { el.currentTime = t; } catch (e) {}
        };
        el.addEventListener('loadedmetadata', cover, { once: true });
        // the real shape of the video, for the reel box (and the like button on it)
        el.addEventListener('loadedmetadata', function () {
          if (el._src !== src || !el.videoWidth || !el.videoHeight) return;
          var ar = el.videoWidth / el.videoHeight;
          if (Math.abs(((self.state.ssVidAr || {})[src] || 0) - ar) < 0.001) return;
          self.setState(function (s) { var m = Object.assign({}, s.ssVidAr); m[src] = ar; return { ssVidAr: m }; });
        }, { once: true });
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
    // ---------- several videos per topic: one after another, each shown as its own video
    ssVidStopUp() { if (this._ssUpT) { clearInterval(this._ssUpT); this._ssUpT = null; } }
    // a video ended: tick it off; if another follows, count down 5 s ("Up next") and then play it
    ssVidEnded(src) {
      var info = (this._ssVidList || {})[src], self = this;
      if (!info) return;
      this.setState(function (s) { var m = Object.assign({}, s.ssVidSeen), o = Object.assign({}, m[info.les]); o[info.i] = true; m[info.les] = o; return { ssVidSeen: m }; });
      if (info.i >= info.n - 1) return;
      this.ssVidStopUp();
      this.setState({ ssVidUp: { les: info.les, i: info.i + 1, at: Date.now() } });
      this._ssUpT = setInterval(function () {
        var u = self.state.ssVidUp;
        if (!u || self._ssVidCtx !== u.les) { self.ssVidStopUp(); if (u) self.setState({ ssVidUp: null }); return; }
        if (Date.now() - u.at >= 5000) self.ssVidGo(u.les, u.i);
        else self.setState({ ssVidTick: Date.now() });
      }, 250);
    }
    // switch to video i of a topic: a short "VIDEO 2" title card, then it plays from 0:00
    ssVidGo(les, i) {
      var vids = (this._ssVidLists || {})[les] || [], url = vids[i], self = this;
      if (!url) return;
      this.ssVidStopUp();
      if (this._ssIntroT) clearTimeout(this._ssIntroT);
      this._ssAutoPlay = url;
      this.setState(function (s) { var m = Object.assign({}, s.ssVidIdx); m[les] = i; return { ssVidIdx: m, ssVidUp: null, ssVidIntro: { les: les, i: i } }; });
      this._ssIntroT = setTimeout(function () {
        self._ssIntroT = null;
        self.setState({ ssVidIntro: null });
        var el = document.querySelector('#ss-reel video');
        if (el && el._src === url) { try { el.currentTime = 0; var p = el.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {} }
        if (self._ssAutoPlay === url) self._ssAutoPlay = null;
      }, 1400);
    }
    ssToast(text, err) {
      var self = this, at = Date.now();
      this.setState({ ssToast: { text: text, err: !!err, at: at } });
      setTimeout(function () { if (self.state.ssToast && self.state.ssToast.at === at) self.setState({ ssToast: null }); }, 4500);
    }

    // Watch: full screen for the whole reel (video + like button). Browsers that cannot put a box in full screen
    // (iPhone) get an in-page full-window view with a close button; Esc closes it too.
    ssReelFull() {
      var el = document.getElementById('ss-reel'), self = this;
      var fake = function () {
        self.setState({ ssReelMax: true });
        if (!self._reelEsc) { self._reelEsc = true; document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && self.state.ssReelMax) self.setState({ ssReelMax: false }); }); }
      };
      var rq = el && (el.requestFullscreen || el.webkitRequestFullscreen);
      if (!rq) return fake();
      try { var p = rq.call(el); if (p && p.catch) p.catch(fake); } catch (e) { fake(); }
    }

    // Code editor: the problem panel's share of the width (20–75%), dragged with the bar between the panels.
    // Saved per browser (localStorage), so it stays the same across problems and visits.
    ssSplitVals() {
      var self = this, S = this.state;
      var pct = S.ssSplit;
      if (pct === undefined) { try { pct = Number(localStorage.getItem('ss:split')) || 42; } catch (e) { pct = 42; } }
      pct = Math.max(20, Math.min(75, pct));
      var save = function (n) {
        n = Math.round(Math.max(20, Math.min(75, n)));
        try { localStorage.setItem('ss:split', String(n)); } catch (e) {}
        self.setState({ ssSplit: n });
      };
      return { w: pct + '%', n: String(Math.round(pct)),
        down: function (e) {
          var box = document.getElementById('ss-split'), bar = e.currentTarget;
          if (!box) return;
          e.preventDefault();
          var r = box.getBoundingClientRect(), last = pct;
          bar.classList.add('on'); document.body.style.userSelect = 'none'; document.body.style.cursor = 'col-resize';
          var move = function (ev) {
            last = Math.max(20, Math.min(75, ((ev.clientX - r.left) / r.width) * 100));
            box.style.setProperty('--ss-left', last + '%'); // live, without re-rendering the editor
          };
          var up = function () {
            window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
            bar.classList.remove('on'); document.body.style.userSelect = ''; document.body.style.cursor = '';
            save(last);
          };
          window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
        },
        key: function (e) {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); save(pct + (e.key === 'ArrowLeft' ? -3 : 3)); }
          else if (e.key === 'Home') { e.preventDefault(); save(20); } else if (e.key === 'End') { e.preventDefault(); save(75); }
        },
        reset: function () { save(42); } };
    }

    // ---------- coding practice honeypots (server/integrity.js): flag only, students see no difference
    // The question being shown in the code editor (same choice as the portal's wsBuild).
    ssCurQuestion() {
      var S = this.state, P = this.ccbpCoding || [];
      if (S.csel === 'play') return null;
      return P.find(function (p) { return p.id === S.csel; }) || P.find(function (p) { return p.topic === (S.ctopic || 'For Loop'); }) || P[0] || null;
    }
    // Question text split around the hidden trap line; the watermark (NIAT ID in zero-width characters) goes after
    // the first word and into the trap line.
    ssHoneypot(v) {
      var text = v.ws ? String(v.ws.text || '') : '';
      var q = this.state.tab === 'code' ? this.ssCurQuestion() : null;
      if (q && (this.ss.integrity || {}).enabled) {
        this._hpQid = q.id;
        var M = this.ssHpMetrics(q.id);
        if (!M.openedAt) M.openedAt = Date.now();
      }
      return this.ssTrapText(text, q);
    }
    // Copy guard "decoy": the problem a copied question is swapped for. Another problem of the same topic (any topic
    // when it has no other), the same one for a student every time, so repeated copies agree.
    ssDecoyFor(qid) {
      var P = this.ccbpCoding || [], q = P.find(function (p) { return p.id === qid; });
      if (!q) return null;
      var pool = P.filter(function (p) { return p.id !== qid && p.topic === q.topic; });
      if (!pool.length) pool = P.filter(function (p) { return p.id !== qid; });
      if (!pool.length) return null;
      var seed = String((this.ss.user || {}).rollNo || '') + qid, h = 0;
      for (var i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
      return pool[h % pool.length];
    }
    // The Practice tab's coding card (pq.ckText): the same hidden line, for the question it shows.
    ssHoneypotCard(v) {
      var pq = v.pq || {}, text = String(pq.ckText || '');
      var q = pq.ckTitle ? (this.ccbpCoding || []).find(function (p) { return p.title === pq.ckTitle; }) : null;
      return this.ssTrapText(text, q || null);
    }
    ssTrapText(text, q) {
      var I = this.ss.integrity || {}, U = this.ss.user;
      if (!q || !I.enabled || !text) return { a: text, trap: '', b: '', qid: '' };
      var wm = I.watermark ? zwEncode(U.kind === 'student' ? U.rollNo : 'ADMIN-' + (U.email || '')) : '';
      var i = text.indexOf('\n\n'), cut = i > 0 ? i : (text.indexOf('. ') > 0 ? text.indexOf('. ') + 1 : text.length);
      var a = text.slice(0, cut), b = text.slice(cut), sp = a.indexOf(' ');
      if (wm && sp > 0) a = a.slice(0, sp) + wm + a.slice(sp);
      return { a: a, trap: ' ' + ((I.questions || {})[q.id] || I.trap || '') + wm + ' ', b: b, qid: q.id };
    }
    ssHpMetrics(qid) {
      this._hp = this._hp || {};
      return this._hp[qid] || (this._hp[qid] = { openedAt: 0, pasteMax: 0, pasteTotal: 0, pasteCount: 0, blurs: 0, awayMs: 0, awayAt: 0 });
    }
    ssHpListen() {
      if (this._hpOn) return;
      this._hpOn = true;
      var self = this;
      var active = function () { return self.state.tab === 'code' && self._hpQid && (self.ss.integrity || {}).enabled; };
      // Copying the question text (marked data-ssq) puts a scrambled version in the clipboard that AI models cannot
      // read reliably: letters shuffled inside words, look-alike Cyrillic letters, invisible characters between
      // letters. The hidden trap line and watermark are kept readable at the start and end. The page is unchanged.
      document.addEventListener('copy', function (e) {
        var I = self.ss.integrity || {};
        if (!I.enabled || I.copyGuard === 'off' || !e.clipboardData) return;
        var tg = e.target, tn = tg && tg.tagName;
        if (tn === 'TEXTAREA' || tn === 'INPUT' || (tg && tg.isContentEditable)) return; // the code editor and inputs copy normally
        var sel = window.getSelection && window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return;
        var node = sel.getRangeAt(0).commonAncestorContainer;
        var el = node && (node.nodeType === 1 ? node : node.parentElement);
        var box = el && el.closest ? el.closest('[data-ssq]') : null;
        if (!box) { // a selection that spans more than the question (e.g. Ctrl+A): scramble if it touches one
          var qs = document.querySelectorAll('[data-ssq]');
          for (var k = 0; k < qs.length && !box; k++) if (sel.containsNode(qs[k], true)) box = qs[k];
        }
        if (!box) return;
        var hid = box.querySelector('span[aria-hidden="true"]');
        var trap = hid ? hid.textContent.replace(/^\s+|\s+$/g, '') : '';
        var text = sel.toString();
        if (trap) text = text.split(trap).join(' ');
        var mode = I.copyGuard || (I.scrambleCopy === false ? 'off' : 'decoy');
        var out = null, qid = box.getAttribute('data-ssq');
        if (!qid) return; // no honeypot on this question (e.g. the Hiring one turned off in integrity.json)
        if (/^hq:/.test(qid)) {
          // Practice → Hiring MCQ: report the copy (HIRING_COPY), and give the clipboard another question of the topic
          var hid0 = qid.slice(3), hd = mode === 'decoy' ? self.ssHqDecoyFor(hid0) : null;
          self.ssHqEvent(hid0, { event: 'copy' });
          if (hd) out = hd.q + (hd.code ? '\n\n' + hd.code : '') + '\n\n' + hd.o.map(function (o, i) { return 'ABCDEF'[i] + '. ' + o; }).join('\n');
        } else if (mode === 'decoy') {
          // a different, real problem: the AI solves the wrong task; Submit then flags DECOY if the code passes its tests
          var d = self.ssDecoyFor(qid);
          if (d) {
            self._hpDecoy = self._hpDecoy || {}; self._hpDecoy[qid] = d.id;
            out = d.title + '\n\n' + String(d.text || '').replace(/`/g, '');
          }
        }
        if (out === null && mode !== 'off') out = scrambleText(text);
        if (out === null) return;
        e.clipboardData.setData('text/plain', (trap ? trap + '\n' : '') + out + (trap ? '\n' + trap : ''));
        e.preventDefault();
      }, true);
      document.addEventListener('paste', function (e) {
        if (!active() || !e.target || e.target.id !== 'ws-code') return;
        var t = '';
        try { t = (e.clipboardData || window.clipboardData).getData('text') || ''; } catch (x) {}
        var M = self.ssHpMetrics(self._hpQid);
        M.pasteCount++; M.pasteTotal += t.length; M.pasteMax = Math.max(M.pasteMax, t.length);
      }, true);
      var away = function () { if (!active()) return; var M = self.ssHpMetrics(self._hpQid); if (!M.awayAt) { M.blurs++; M.awayAt = Date.now(); } };
      var back = function () { if (!self._hpQid) return; var M = self.ssHpMetrics(self._hpQid); if (M.awayAt) { M.awayMs += Date.now() - M.awayAt; M.awayAt = 0; } };
      window.addEventListener('blur', away);
      window.addEventListener('focus', back);
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') away(); else back(); });
    }
    // Submit in the code editor: the portal grades with checkTests; report that run's result with the metrics.
    checkTests(code, tests) {
      var res = super.checkTests(code, tests), pend = this._hpPending, self = this;
      if (pend && pend.code === code) {
        this._hpPending = null;
        Promise.resolve(res).then(function (r) {
          var ok = Array.isArray(r) && r.length > 0 && r.every(function (x) { return x.pass; });
          if (ok) self.ssCue('right');
          var did = (self._hpDecoy || {})[pend.qid], dq = did && (self.ccbpCoding || []).find(function (p) { return p.id === did; });
          if (ok || !dq || !(dq.tests || []).length) return { r: r, ok: ok, decoy: null };
          return Promise.resolve(Component.prototype.checkTests.call(self, code, dq.tests)).then(function (dr) {
            return { r: r, ok: ok, decoy: { id: did, passed: Array.isArray(dr) && dr.length > 0 && dr.every(function (x) { return x.pass; }) } };
          }, function () { return { r: r, ok: ok, decoy: null }; });
        }).then(function (o) {
          var r = o.r, M = self.ssHpMetrics(pend.qid), f = document.getElementById('ss-hp-field');
          api('POST', '/api/practice/submission', { qid: pend.qid, topic: pend.topic, code: code, correct: o.ok,
            decoyId: o.decoy ? o.decoy.id : '', decoyPassed: !!(o.decoy && o.decoy.passed),
            pasteMax: M.pasteMax, pasteTotal: M.pasteTotal, pasteCount: M.pasteCount, blurs: M.blurs, awayMs: M.awayMs,
            timeMs: M.openedAt ? Date.now() - M.openedAt : 0, bot: f ? f.value : '' }).catch(function () {});
        }, function () {});
      }
      return res;
    }

    // Feedback (post-test pop-up and the Feedback button): one required question on AI use in the Sprint/practice
    // questions. The answer goes with the feedback (saveFeedback below).
    ssAiFeedback(v) {
      var S = this.state, self = this, fb = v.fb || {};
      var on = !!fb.modal; // the post-test pop-up and the Feedback button
      if (!on) return { on: false, req: 'Both questions are required.', use: { opts: [], err: false } };
      var tried = !!S.fbTried;
      var group = function (key) {
        var cur = (S.ssAi || {})[key];
        return { err: tried && cur === undefined, opts: AI_LEVELS.map(function (t, i) {
          var picked = cur === i;
          return { t: t, on: picked, ring: picked ? '#FFE45C' : '#333333', bg: picked ? 'rgba(255,228,92,.10)' : 'transparent', fg: picked ? '#FFFFFF' : '#BDBDBD', dot: picked ? '#FFE45C' : 'transparent',
            pick: function () { self.setState(function (s) { var a = Object.assign({}, s.ssAi); a[key] = i; return { ssAi: a }; }); } };
        }) };
      };
      var a = S.ssAi || {}, both = a.use !== undefined;
      var base = fb.submit;
      fb.submit = function () {
        if (!both) { self.setState({ fbTried: true }); return; }
        self._ssAiAnswer = { aiUse: AI_LEVELS[a.use] };
        base.apply(this, arguments);
        self.setState({ ssAi: {} });
      };
      if (!both) { fb.notReady = true; fb.subCls = ''; fb.subBg = '#262626'; fb.subFg = '#8A8A8A'; }
      return { on: true, req: 'All questions are required.', use: group('use') };
    }

    // Practice follows Learn: practice topics take the name of the Learn topic they match (its "Practice topic" set in
    // Admin → Courses & topics, else a similar name: "Type Conversions" → "Type Conversion"), and topics that are not in
    // Learn now are hidden. Items keep their position, because answers are stored by it. If nothing matches (no Learn
    // content yet), Practice is left as it is.
    ssPracticeFollowsLearn() {
      var key = function (s) {
        return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/\binro\b|\bintroduction\b/g, 'intro')
          .replace(/\bpart\s*-?\s*\d+\b/g, '').replace(/[^a-z0-9]+/g, '').replace(/s$/, '');
      };
      // the same key with the Part number kept: "… Part 1" and "… Part 2" are two topics, matched before the general key
      var keyP = function (s) { var m = /\bpart\s*-?\s*(\d+)\b/i.exec(String(s || '')); return m ? key(s) + '#' + m[1] : ''; };
      var learn = {};
      var put = function (name, as) { learn[key(name)] = as; if (keyP(name)) learn[keyP(name)] = as; };
      this.courseList().forEach(function (c) { c.modules.forEach(function (m) { if (m.name) put(m.name, m.name); }); });
      this.courseList().forEach(function (c) { c.modules.forEach(function (m) { if (m.name && m.practiceTopic) put(m.practiceTopic, m.name); }); });
      // a "Part 2" question never lands on a "Part 1" topic (when its own Part is missing it stays hidden)
      var partOf = function (s) { var m = /\bpart\s*-?\s*(\d+)\b/i.exec(String(s || '')); return m ? m[1] : ''; };
      var find = function (s) {
        if (keyP(s) && learn[keyP(s)]) return learn[keyP(s)];
        var m = learn[key(s)] || '';
        return m && partOf(s) && partOf(m) && partOf(m) !== partOf(s) ? '' : m;
      };
      var lists = ['practice', 'ccbpQuiz', 'genaiQuiz'], self = this;
      var any = lists.some(function (n) { return (self[n] || []).some(function (p) { return p.sess && find(p.sess); }); });
      if (!any) return;
      lists.forEach(function (n) {
        self[n] = (self[n] || []).map(function (p) { return p.sess ? Object.assign({}, p, { sess: find(p.sess) }) : p; });
      });
      this.ccbpCoding = (this.ccbpCoding || []).map(function (p) { return p.topic ? Object.assign({}, p, { topic: find(p.topic) }) : p; });
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
      // a course with no practice topics (e.g. none of its Learn topics has questions yet) is not listed
      if (v.pq && Array.isArray(v.pq.groups)) v.pq.groups = v.pq.groups.filter(function (g) { return g.topics.length; });
      var on = S.tab === 'board';
      v.nav.board = { go: function () { self.xpStop(); self.setState({ tab: 'board' }); self.ssLoadBoard(true); }, bg: on ? '#FFE45C' : 'transparent', fg: on ? '#050505' : '#FFFFFF' };
      v.show.board = on;
      // Phones: the test tab shows a "use a laptop or desktop" card instead of the test (results stay visible).
      v.show.phoneTest = !!(S.ssPhone && v.show.test && !S.tDone);
      if (v.show.phoneTest) v.show.test = false;
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
      // the course of each question is not shown in the test ("MCQ 3 of 18 · 1 mark")
      if (v.tq && v.tq.label) v.tq.label = String(v.tq.label).replace(/^[^·]*·\s*/, '');
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
      if (v.status && /closes 11:30 AM/.test(v.status.top || '')) v.status.top = 'The test is open · closes ' + when.close;
      if (this.ss.sprint.preview) v.t.readyNote = '(Admin preview' + (sp.previewOf ? ' of Sprint "' + sp.previewOf + '"' : '') + ': opens any time, ' + mins + '-minute timer, not ranked.)';

      // Lessons: units are one lesson with three steps (Watch → Play → Read); older lessons keep their own media.
      var CO = this.courseList()[S.course], mod = CO && CO.modules[S.mod], les = mod && mod.lessons[S.les];
      var w = les && les.watch && typeof les.watch === 'object' ? les.watch : {};
      var portrait = w.orientation === 'portrait';
      // the reel box: the video's own size (width capped so its height fits 78% of the window). Its shape comes from
      // the video file itself once its metadata has loaded, so the like button sits on the picture, never on black bars;
      // until then the topic's orientation is the guess.
      var reelSize = function (vsrc) {
        var ar = vsrc && (S.ssVidAr || {})[vsrc];
        if (ar) portrait = ar < 1;
        else ar = portrait ? 0.5625 : 1.7778;
        var a = ar.toFixed(4);
        return { ar: a, aspect: a + ' / 1', boxW: portrait ? 'min(100%, 440px, calc(78vh * ' + a + '))' : 'min(100%, calc(78vh * ' + a + '))' };
      };
      var reel = reelSize(w.src), reelW = reel.boxW, reelAr = reel.ar;
      if (v.wt) { v.wt.vw = portrait ? 'min(100%, 440px)' : '100%'; v.wt.aspect = reel.aspect; v.wt.tall = !!w.tall; v.wt.boxW = reelW; v.wt.ar = reelAr; }
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
      this._ssVidCtx = null; // the topic whose Watch step is on screen (set below); the "Up next" countdown stops without it
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
          // Play (game) and Read open in full screen straight away: the click that opens them allows it. Esc leaves.
          if ((t === 'play' || t === 'read') && !self.ssProctorActive()) setTimeout(function () {
            var el = document.getElementById('ss-embed'), rq = el && (el.requestFullscreen || el.webkitRequestFullscreen);
            if (rq && document.fullscreenElement !== el) { try { var p = rq.call(el); if (p && p.catch) p.catch(function () {}); } catch (e) {} }
          }, 120);
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
          return { name: st[1], arrow: i > 0, cur: on, done: dn, line: i <= ti ? '#FFE45C' : '#333333', mark: dn ? '✓' : String(i + 1),
            ring: on ? '#FFE45C' : dn ? '#5E5E5E' : '#333333', bg: on ? 'rgba(255,228,92,.12)' : 'transparent', fg: on ? '#FFE45C' : dn ? '#EDEDED' : '#8A8A8A',
            dotBg: on || dn ? '#FFE45C' : '#262626', dotFg: on || dn ? '#050505' : '#8A8A8A', go: function () { setTab(st[0]); } };
        });
        // Content for the current step
        v.xpShow = false; v.recShow = true; v.recAvail = false;
        if (tab === 'watch') {
          // A topic can have several videos (Admin: watch, watch2 … watch6). They play one after another, each as its own video.
          var vids = src.watch ? [src.watch].concat(['watch2', 'watch3', 'watch4', 'watch5', 'watch6'].map(function (k) { return over[k]; }).filter(Boolean)) : [];
          var vi = Math.min(Math.max(0, (S.ssVidIdx || {})[les.id] || 0), Math.max(0, vids.length - 1)), vcur = vids[vi] || '';
          this._ssVidUnit = this._ssVidUnit || {}; this._ssVidList = this._ssVidList || {}; this._ssVidLists = this._ssVidLists || {};
          this._ssVidLists[les.id] = vids; this._ssVidCtx = les.id;
          vids.forEach(function (u, i) { self._ssVidUnit[u] = les.id; self._ssVidList[u] = { les: les.id, i: i, n: vids.length }; });
          var rs = reelSize(vcur);
          v.wt = Object.assign({}, v.wt, { isVideo: !!vcur, isSlides: false, src: vcur, title: les.title + (vids.length > 1 ? ' · video ' + (vi + 1) + ' of ' + vids.length : ''), groups: [], tall: false,
            vw: portrait ? 'min(100%, 440px)' : '100%', aspect: rs.aspect, boxW: rs.boxW, ar: rs.ar, ref: vcur ? this.ssVideoRef(vcur) : null });
          if (vids.length > 1) {
            var seen = (S.ssVidSeen || {})[les.id] || {}, up = S.ssVidUp && S.ssVidUp.les === les.id ? S.ssVidUp : null;
            var intro = S.ssVidIntro && S.ssVidIntro.les === les.id ? S.ssVidIntro : null;
            var left = up ? Math.max(0, Math.ceil((5000 - (Date.now() - up.at)) / 1000)) : 0;
            v.ss_pl = { on: true, n: String(vids.length), badge: 'VIDEO ' + (vi + 1) + ' / ' + vids.length,
              items: vids.map(function (u, i) {
                return { label: 'Video ' + (i + 1), pressed: i === vi, tick: seen[i] && i !== vi ? '✓' : '', go: function () { if (i !== vi) self.ssVidGo(les.id, i); } };
              }),
              up: !!up, upLabel: up ? 'Video ' + (up.i + 1) + ' of ' + vids.length : '', upLeft: String(left), upPct: up ? Math.min(100, (Date.now() - up.at) / 50) + '%' : '0%',
              upNow: function () { if (self.state.ssVidUp) self.ssVidGo(les.id, self.state.ssVidUp.i); },
              upCancel: function () { self.ssVidStopUp(); self.setState({ ssVidUp: null }); },
              intro: !!intro, introBig: intro ? 'VIDEO ' + (intro.i + 1) : '', introSub: intro ? 'of ' + vids.length + ' · ' + les.title : '' };
          }
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
        // Toolbar above the media: a full-screen icon button (Watch: the reel with its like button; Play and Read: the
        // game or notes frame; browsers without it get a new tab).
        if (src[tab]) {
          var fsUrl = src[tab], isPR = tab === 'play' || tab === 'read';
          v.ss_tools = { on: true, hint: tab === 'play' ? 'Press Esc to leave full screen' : tab === 'read' ? 'Read in full screen · Esc to leave' : '',
            fs: true, fsGo: function () {
              if (tab === 'watch') return self.ssReelFull();
              var el = document.getElementById('ss-embed');
              var rq = el && (el.requestFullscreen || el.webkitRequestFullscreen);
              var tab2 = function () { window.open(fsUrl, '_blank', 'noopener'); };
              if (!rq) return tab2();
              try { var p = rq.call(el); if (p && p.catch) p.catch(tab2); } catch (e) { tab2(); }
            } };
        }
        // Watch: like button on the video (one like per student per topic)
        // Admins see the heart and the count too (read-only): their clicks are not counted.
        if (tab === 'watch' && src.watch) {
          var likedSet = S.ssLiked || {}, liked = !!likedSet[les.id], cnt = Math.max(0, (S.ssLikeN || {})[les.id] || 0);
          var lid = les.id;
          var burst = !!S.ssLikeBurst && Date.now() - S.ssLikeBurst < 850;
          v.ss_like = { on: true, liked: liked, count: cnt ? String(cnt) : '', fill: liked ? '#FF3040' : 'none', stroke: liked ? '#FF3040' : '#FFFFFF',
            cls: liked ? 'ss-like-pop' : '', burst: burst,
            // double-click / double-tap on the video likes it (never unlikes), with a heart burst in the middle
            dbl: function (e) {
              if (e && e.preventDefault) e.preventDefault();
              var t = Date.now();
              self.setState({ ssLikeBurst: t });
              setTimeout(function () { if (self.state.ssLikeBurst === t) self.setState({ ssLikeBurst: 0 }); }, 850);
              if (!((self.state.ssLiked || {})[lid])) v.ss_like.toggle();
            },
            label: (liked ? 'Unlike' : 'Like') + ' this video · ' + cnt + ' like' + (cnt === 1 ? '' : 's'),
            toggle: function () {
              if (U.kind !== 'student') { self.ssToast('Admin preview: likes are only counted for students.'); return; }
              var now = !((self.state.ssLiked || {})[lid]);
              self.setState(function (s2) {
                var L2 = Object.assign({}, s2.ssLiked), N2 = Object.assign({}, s2.ssLikeN);
                L2[lid] = now; N2[lid] = Math.max(0, (N2[lid] || 0) + (now ? 1 : -1));
                return { ssLiked: L2, ssLikeN: N2 };
              });
              api('POST', '/api/likes/' + encodeURIComponent(lid), { liked: now }).then(function (r) {
                if (r && typeof r.count === 'number') self.setState(function (s2) { var N2 = Object.assign({}, s2.ssLikeN); N2[lid] = r.count; return { ssLikeN: N2 }; });
              }, function () {
                self.setState(function (s2) { var L2 = Object.assign({}, s2.ssLiked), N2 = Object.assign({}, s2.ssLikeN); L2[lid] = !now; N2[lid] = Math.max(0, (N2[lid] || 0) + (now ? -1 : 1)); return { ssLiked: L2, ssLikeN: N2 }; });
              });
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

      if (v.ws && typeof v.ws.submit === 'function' && (this.ss.integrity || {}).enabled) {
        var q0 = this.state.tab === 'code' ? this.ssCurQuestion() : null, baseSubmit = v.ws.submit;
        if (q0) v.ws.submit = function () {
          var el = document.getElementById('ws-code');
          self._hpPending = { qid: q0.id, topic: q0.topic, code: el ? el.value : '' };
          var st = self.state.code || {};
          if (st[q0.id] !== undefined) self._hpPending.code = st[q0.id];
          else if (q0.starter !== undefined && !el) self._hpPending.code = q0.starter;
          return baseSubmit.apply(this, arguments);
        };
      }

      // ---------- layout: focus mode, top bar, sidebar topics, menus, music, Home map
      var focus = !!S.ssFocus;
      if (focus) v.side = { full: false, mini: true, w: '84px', pad: '12px', jc: 'center', align: 'center', rot: 'rotate(180deg)', label: 'Expand menu', toggle: v.side.toggle };
      else v.side.mini = !v.side.full;
      var topicItems = this.ssTopicItems(v);
      // Learn has no Topics panel any more (the sidebar lists the topics): keep it closed even if it was open before.
      v.listOpen = false; v.listClosed = true;
      v.ss_topics = { open: S.ssTopicsOpen !== false, show: S.ssTopicsOpen !== false && !!v.side.full, rot: S.ssTopicsOpen !== false ? 'rotate(180deg)' : 'none',
        toggle: function () { if (!v.side.full) { self.setState({ tab: 'learn', ssTopicsOpen: true, ssMenu: '' }); return; } self.setState(function (s) { return { ssTopicsOpen: s.ssTopicsOpen === false }; }); },
        list: (function () { var out = [], last = null; topicItems.forEach(function (t) {
          if (t.course !== last) { out.push({ isHead: true, isTopic: false, name: t.course }); last = t.course; }
          out.push({ isHead: false, isTopic: true, name: t.name, title: t.course + ' · ' + t.name + (t.done ? ' · done' : ''), go: t.go, on: t.cur, bg: t.cur ? '#FFE45C' : 'transparent', fg: t.cur ? '#050505' : t.done ? '#DADADA' : '#8A8A8A', dot: t.done ? '#FFE45C' : t.cur ? '#050505' : '#333333' });
        }); return out; })() };
      v.map = v.show.home ? this.ssMapVals(v) : { on: false, items: [], avatar: {}, trophy: {} };
      v.nav.test.on = S.tab === 'test'; v.nav.board.on = S.tab === 'board'; v.nav.practice.on = S.tab === 'practice' || S.tab === 'code';
      // leaving Practice leaves focus mode; opening Practice enters it (full screen needs the click that opens it)
      var basePractice = v.nav.practice.go, baseTest = v.nav.test.go, baseLearn = v.nav.learn.go, baseBrand = v.nav.brand;
      // Focus mode (full screen, sidebar minimised) stays on across tabs until the student leaves it; Practice turns it on.
      v.nav.practice.go = function () { basePractice(); self.setState({ ssMenu: '' }); if (!self.state.ssFocus) self.ssFocus(true); };
      v.nav.test.go = function () { baseTest(); self.setState({ ssMenu: '' }); };
      v.nav.learn.go = function () { baseLearn(); self.setState({ ssMenu: '' }); };
      v.nav.brand = function () { baseBrand(); self.setState({ ssMenu: '' }); };
      var baseBoard = v.nav.board.go;
      v.nav.board.go = function () { baseBoard(); self.setState({ ssMenu: '' }); };

      // ---------- profile tab (photo, streak, medals; GET /api/journey) and marathon wording on Home
      var onPf = S.tab === 'profile';
      v.show.profile = onPf;
      if (onPf) v.crumb = '~/profile';
      if (v.today && v.today.cdLabel) {
        v.today.cdLabel = v.today.cdLabel === 'Sprint test opens in' ? 'Starting gun in' : v.today.cdLabel === 'Sprint test is live now' ? 'Race day · the test is open'
          : v.today.cdLabel === 'Sprint test closed' ? 'Race over · see the leaderboard' : v.today.cdLabel;
      }
      // Sound cues: the gun when the test opens, a tick each of the last 10 s, right/wrong when a practice answer is checked.
      var ph = v.status && v.status.live ? (this.ssRunning() ? 'running' : 'ready') : 'off';
      if (this._ssPhase && this._ssPhase !== 'ready' && ph === 'ready') this.ssCue('start');
      this._ssPhase = ph;
      if (ph === 'running') { var left = Math.ceil((this.ssEndAt() - Date.now()) / 1000); if (left >= 0 && left <= 10 && left !== this._ssTick) { this._ssTick = left; this.ssCue('tick'); } }
      if (v.pq && v.pq.q) {
        // keyed by the question's place in Practice, not its text: many questions share the same wording
        var qk = String(S.pc || '') + '|' + String(S.pi || 0) + '|' + String(v.pq.q).slice(0, 40), seen = this._ssVdSeen || (this._ssVdSeen = {}), has = !!v.pq.verdict;
        if (has && seen[qk] === false) this.ssCue(v.pq.verdict === 'Correct' ? 'right' : 'wrong');
        seen[qk] = has;
      }

      // Practice "Hiring" tab: load once when Practice opens; Quiz / Coding / another topic leave it
      if (S.tab === 'practice' && !S.ssHiring) this.ssLoadHiring();
      if (v.pq) v.pq.listOpen = false; // Practice has no Topics panel any more: the sidebar topics switch it
      // A topic with Hiring questions but no Quiz questions (picked in the sidebar on Practice): Practice shows it with
      // only its Hiring tab, under that topic's own name and course.
      var hqOnly = S.tab === 'practice' && S.ssHqTopic && v.pq ? S.ssHqTopic : null;
      if (hqOnly) Object.assign(v.pq, { topicLabel: hqOnly.name, courseLabel: hqOnly.course, nQuiz: '0', hasCoding: false, isQuizItem: false, isCodeItem: false });
      v.hq = this.ssHiringVals(v);
      if (hqOnly && v.hq) v.pq.score = v.hq.correct + ' / ' + v.hq.n; // the score is this topic's Hiring score
      v.ss_pt = S.tab === 'practice' ? this.ssPracticeTopicVals(v, hqOnly) : null;
      if (v.pq && v.hq) {
        var baseQuiz = v.pq.toQuiz, baseCode = v.pq.toCode;
        v.pq.toQuiz = hqOnly ? function () { self.ssToast('This topic has no quiz questions yet. Practise its Hiring questions.'); }
          : function () { self.setState({ ssPHire: false }); if (baseQuiz) baseQuiz(); };
        v.pq.toCode = function () { self.setState({ ssPHire: false, ssHqTopic: null }); if (baseCode) baseCode(); };
        if (v.hq.on) { v.pq.qBg = 'transparent'; v.pq.qFg = '#BDBDBD'; }
      }
      v.lb = this.ssBoardVals();
      v.ss = {
        when: when,
        prev: unitsPrev || { on: false, label: '', go: null },
        soon: v.ss_soon || { on: false, kicker: '', text: '' },
        ai: this.ssAiFeedback(v),
        next: (function () {
          var N = self.ss.nextSprint, open = !S.ssNextFolded;
          if (!N || !Array.isArray(N.groups) || !N.groups.length) return { on: false };
          return { on: true, title: N.title, when: when.line + ' · ' + when.dur, open: open, toggleLabel: open ? 'Hide' : 'Show topics',
            toggle: function () { self.setState(function (s) { return { ssNextFolded: !s.ssNextFolded }; }); },
            groups: N.groups.map(function (g) { return { name: g.name, topics: g.topics.map(function (t) { return { t: t }; }) }; }) };
        })(),
        tools: v.ss_tools || { on: false, hint: '', fs: false, fsGo: null },
        like: v.ss_like || { on: false },
        pl: v.ss_pl || { on: false, items: [], up: false, intro: false },
        pt: v.ss_pt || { open: false, groups: [], has: false, toggle: null },
        split: this.ssSplitVals(),
        reel: { max: !!S.ssReelMax, cls: S.ssReelMax ? 'ss-reel-max' : '', close: function () { self.setState({ ssReelMax: false }); } },
        hp: this.ssHoneypot(v),
        hpc: this.ssHoneypotCard(v),
        user: {
          name: U.name || (U.kind === 'admin' ? U.email : U.rollNo),
          sub: U.kind === 'admin' ? (U.role === 'super_admin' ? 'super admin' : 'admin') + ' · preview' : U.rollNo + (U.batch ? ' · ' + U.batch : ''),
          isAdmin: U.kind === 'admin',
          noPhoto: !(U.kind === 'student' && !!U.photoAt), initial: String(U.name || '?').trim().charAt(0).toUpperCase(),
          ring: S.tab === 'profile' ? '#FFE45C' : 'transparent', bg: S.tab === 'profile' ? 'rgba(255,228,92,.08)' : 'transparent',
          open: function () {
            if (self.ssProctorActive()) { self.ssToast('Finish and submit the Sprint first.', true); return; }
            self.xpStop(); self.setState({ tab: 'profile', ssMenu: '' }); self.ssLoadJourney();
          },
          menuOpen: S.ssMenu === 'user', menu: function () { self.setState(function (s) { return { ssMenu: s.ssMenu === 'user' ? '' : 'user' }; }); },
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
        topics: v.ss_topics,
        top: { show: true, full: !focus, quoteOn: (S.tab === 'practice' || S.tab === 'code') && !!(v.today && v.today.quote), quote: v.today ? v.today.quote : '', by: v.today ? v.today.by : '' },
        focus: { on: focus, off: !focus, label: focus ? 'Leave focus mode' : 'Focus mode', fg: focus ? '#FFE45C' : '#8A8A8A',
          toggle: function () { self.ssFocus(!self.state.ssFocus); } },
        music: { on: !!S.ssMusicOn, label: S.ssMusicOn ? 'Music on' : 'Music off', toggle: function () { self.ssMusic(!self.state.ssMusicOn); } },
        // One button for everything you hear: the cues (practice right/wrong, the gun, the ticks) and the background music.
        // The horn opens a dropdown: Sound effects (cues: practice right/wrong, the gun, the ticks) and Music, each its own tick.
        audio: (function () { var sfx = S.snd !== false, music = !!S.ssMusicOn, on = sfx || music; return { on: on, off: !on, open: S.ssMenu === 'audio',
          label: sfx && music ? 'Sound on' : sfx ? 'Effects only' : music ? 'Music only' : 'Sound off', sfxOn: sfx, musicOn: music,
          toggle: function () { self.setState(function (s) { return { ssMenu: s.ssMenu === 'audio' ? '' : 'audio' }; }); },
          sfxToggle: function () { var now = self.state.snd === false; self._ssGesture = true; self.setState({ snd: now }); try { localStorage.setItem('ss-snd2', now ? '1' : '0'); } catch (e) {}
            if (self._am && self._ac) self._am.gain.setTargetAtTime(now ? 1 : 0, self._ac.currentTime, 0.05); if (now) { try { self.au(); self.sfx('click'); } catch (e) {} } },
          musicToggle: function () { self._ssGesture = true; self.ssMusic(!self.state.ssMusicOn); } }; })(),
        more: { open: S.ssMenu === 'more', toggle: function () { self.setState(function (s) { return { ssMenu: s.ssMenu === 'more' ? '' : 'more' }; }); },
          home: function () { v.nav.brand(); }, topics: function () { self.setState({ tab: 'learn', ssMenu: '', ssTopicsOpen: true }); },
          practice: function () { v.nav.practice.go(); }, test: function () { v.nav.test.go(); }, board: function () { v.nav.board.go(); } },
        snd: (function () { var on = S.snd !== false; return { on: on, off: !on, label: on ? 'Sound on' : 'Sound off', fg: on ? '#FFE45C' : '#8A8A8A',
          toggle: function () { var now = self.state.snd === false; self.setState({ snd: now }); try { localStorage.setItem('ss-snd2', now ? '1' : '0'); } catch (e) {}
            if (self._am && self._ac) self._am.gain.setTargetAtTime(now ? 1 : 0, self._ac.currentTime, 0.05);
            if (now) { self._ssGesture = true; try { self.au(); self.sfx('click'); } catch (e) {} } } }; })(),
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
      v.pf = this.ssProfileVals(v);
      return v;
    }
  }

  // Feedback goes to the server (the portal also keeps its local copy).
  var baseSave = Component.prototype.saveFeedback;
  SprintPortal.prototype.saveFeedback = function (rec) {
    if (this._ssAiAnswer && rec) { rec = Object.assign({}, rec, this._ssAiAnswer); this._ssAiAnswer = null; }
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

  // Every student needs a photograph and a name before the portal opens. Accounts without them (registered before
  // photos were required, or listed without a name) see this screen first; an admin can also ask for a new photo.
  function photoGate(B, done) {
    var needPhoto = !B.user.photoAt || !!B.user.photoUpdate, needName = !!B.user.needsName;
    var app = document.getElementById('app'), data = '';
    app.innerHTML = '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0A0A0A;color:#EDEDED;font-family:JetBrains Mono,monospace;padding:24px;box-sizing:border-box">' +
      '<div style="width:100%;max-width:520px;display:flex;flex-direction:column;gap:18px;background:#151515;border-radius:22px;padding:28px;box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 24px 48px -20px rgba(0,0,0,.9)">' +
      '<div style="font-family:VT323,monospace;font-size:20px;color:#FFE45C">~/profile</div>' +
      '<div data-k="title" style="font-family:Silkscreen,monospace;font-size:28px;line-height:1.1;color:#FFFFFF"></div>' +
      '<div data-k="hello" style="font-size:15px;line-height:1.55;color:#BDBDBD"></div>' +
      '<label data-k="nameWrap" style="display:none;flex-direction:column;gap:8px"><span style="font-size:14px;font-weight:800;color:#FFFFFF">Your full name</span>' +
      '<input data-k="name" type="text" maxlength="80" autocomplete="name" placeholder="e.g. Asha Kumar" style="min-height:48px;padding:0 14px;border:2px solid #333333;border-radius:12px;background:#050505;color:#FFFFFF;font-family:inherit;font-size:16px"></label>' +
      '<div data-k="photoWrap" style="display:none;align-items:center;gap:16px"><div data-k="prev" style="width:112px;height:112px;flex-shrink:0;border-radius:16px;border:2px dashed #333333;background:#050505;display:flex;align-items:center;justify-content:center;overflow:hidden;color:#5E5E5E;font-size:12px">no photo</div>' +
      '<button data-k="choose" type="button" style="min-height:46px;padding:0 18px;border:2px solid #333333;border-radius:12px;background:transparent;color:#FFFFFF;font-family:inherit;font-size:15px;font-weight:800;cursor:pointer">Choose a photo</button></div>' +
      '<div data-k="msg" role="alert" style="display:none;padding:10px 14px;border-radius:12px;border:2px solid #FF7A7A;color:#FF7A7A;font-size:14px;font-weight:700"></div>' +
      '<button data-k="save" type="button" disabled style="min-height:50px;border:0;border-radius:14px;background:#262626;color:#8A8A8A;font-family:inherit;font-size:16px;font-weight:800;cursor:not-allowed">Save and open the portal</button>' +
      '<button data-k="out" type="button" style="align-self:flex-start;border:0;background:none;color:#8A8A8A;font-family:inherit;font-size:14px;font-weight:700;text-decoration:underline;cursor:pointer;padding:0">Log out</button>' +
      '</div></div>';
    var $ = function (k) { return app.querySelector('[data-k="' + k + '"]'); };
    var first = String(B.user.name || '').trim().split(/\s+/)[0];
    $('title').textContent = needName && needPhoto ? 'Complete your profile' : needName ? 'Add your name' : B.user.photoAt ? 'Update your photograph' : 'Add your photograph';
    $('hello').textContent = (first ? 'Hi ' + first + '. ' : '') + (needName ? 'Type your full name as in your college records. ' : '') +
      (needPhoto ? 'Add a clear, recent photo of your face. It appears on your profile and the leaderboard and helps mentors recognise you.' : '');
    if (needName) $('nameWrap').style.display = 'flex';
    if (needPhoto) $('photoWrap').style.display = 'flex';
    var say = function (t) { var m = $('msg'); m.textContent = t || ''; m.style.display = t ? 'block' : 'none'; };
    var nameOk = function () { return !needName || $('name').value.trim().replace(/\s+/g, ' ').length >= 2; };
    var ready = function () { var on = nameOk() && (!needPhoto || !!data), b = $('save'); b.disabled = !on; b.style.background = on ? '#FFE45C' : '#262626'; b.style.color = on ? '#050505' : '#8A8A8A'; b.style.cursor = on ? 'pointer' : 'not-allowed'; };
    $('name').oninput = function () { say(''); ready(); };
    $('choose').onclick = function () {
      pickPhoto().then(function (d) {
        data = d; say('');
        var img = document.createElement('img'); img.src = d; img.alt = 'Your photo'; img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
        var p = $('prev'); p.replaceChildren(img); p.style.border = '2px solid #FFE45C';
        $('choose').textContent = 'Change photo'; ready();
      }, function (e) { say(e.message); });
    };
    $('save').onclick = function () {
      if ($('save').disabled) return;
      $('save').disabled = true; $('save').textContent = 'Saving…';
      var nm = $('name').value.trim().replace(/\s+/g, ' ');
      (needName ? api('PUT', '/api/me/name', { name: nm }).then(function () { B.user.name = nm; B.user.needsName = false; needName = false; }) : Promise.resolve())
        .then(function () { return needPhoto ? api('PUT', '/api/me/photo', { photo: data }).then(function (r) { B.user.photoAt = r.photoAt; }) : null; })
        .then(function () { app.innerHTML = ''; done(); },
          function (e) { say(e.message); $('save').textContent = 'Save and open the portal'; ready(); });
    };
    $('out').onclick = function () { api('POST', '/api/auth/logout').then(function () { location.href = '/login'; }, function () { location.href = '/login'; }); };
  }

  api('GET', '/api/bootstrap').then(function (B) {
    clock.offset = B.serverNow - Date.now();
    window.__ssBoot = B;
    var boot = function () { bootPortal(SprintPortal, { testMode: B.sprint.preview ? 'preview-open' : 'auto' }); };
    var testRunning = B.attempt && B.attempt.status === 'running';
    if (B.user.kind === 'student' && (!B.user.photoAt || B.user.photoUpdate || B.user.needsName) && !testRunning && window.SSPhoto) photoGate(B, boot); else boot();
  }, function (e) { if (e.code !== 'AUTH') fail(e.message); });
})();
