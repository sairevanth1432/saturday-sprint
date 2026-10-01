/* Saturday Sprint · portal bridge
 * Connects the single-file portal to the server without changing its look:
 *  - boots only after /api/bootstrap confirms a login session (otherwise → /login)
 *  - Sprint test: questions come from the server when the test starts; answers autosave;
 *    hidden tests and final grading run on the server
 *  - leaderboard tab, Home card and post-test standings
 *  - lesson/practice progress synced to the account
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
      var field = function (c) { return c === 'pf' ? 'pfModules' : c === 'genai' ? 'modules' : null; };
      if (pack.mode === 'replace') pack.units.forEach(function (u) { var f = field(u.course); if (f && !self['_ssReplaced' + f]) { self[f] = []; self['_ssReplaced' + f] = true; } });
      pack.units.forEach(function (u) {
        var f = field(u.course);
        if (f && !self[f].some(function (m) { return m._pack && m.name === u.name; })) self[f].push({ name: u.name, color: u.color, lessons: u.lessons, _pack: true });
      });
      // Lesson progress is stored by position; when the course content changes, old ticks would land on new lessons.
      this._ssContentV = this.courseList().map(function (c) { return c.id + ':' + c.modules.map(function (m) { return m.lessons.map(function (l) { return l.id; }).join(','); }).join('|'); }).join(';');

      var p = B.progress || {};
      var sameContent = p.cv === this._ssContentV;
      PROGRESS_KEYS.forEach(function (k) { if (p[k] !== undefined && (k !== 'done' || sameContent)) S[k] = p[k]; });
      if (!sameContent) { S.course = 0; S.mod = 0; S.les = 0; }
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

    renderVals() {
      var v = super.renderVals(), S = this.state, self = this, U = this.ss.user;
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
      v.t.start = function () { self.ssStart(); };
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
      if (this.ss.sprint.preview) v.t.readyNote = '(Admin preview: opens any time, ' + mins + '-minute timer, not ranked.)';

      // Lessons: units are one lesson with three steps (Watch → Play → Read); older lessons keep their own media.
      var CO = this.courseList()[S.course], mod = CO && CO.modules[S.mod], les = mod && mod.lessons[S.les];
      var w = les && les.watch && typeof les.watch === 'object' ? les.watch : {};
      var portrait = w.orientation === 'portrait';
      if (v.wt) { v.wt.vw = portrait ? 'min(100%, 440px)' : '100%'; v.wt.aspect = portrait ? '9 / 16' : '16 / 9'; v.wt.tall = !!w.tall; }
      var unitsPrev = null;
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
          v.wt = Object.assign({}, v.wt, { isVideo: !!src.watch, isSlides: false, src: src.watch, title: les.title, groups: [], tall: false,
            vw: portrait ? 'min(100%, 440px)' : '100%', aspect: portrait ? '9 / 16' : '16 / 9', ref: src.watch ? this.ssVideoRef(src.watch) : null });
        } else {
          v.wt = Object.assign({}, v.wt, { isVideo: false, isSlides: !!src[tab], src: src[tab], title: les.title, groups: [], tall: true, ref: null });
        }
        v.ss_readSoon = tab === 'read' && !src.read;
        v.ss_missing = tab !== 'read' && !src[tab];
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

      v.lb = this.ssBoardVals();
      v.ss = {
        when: when,
        prev: unitsPrev || { on: false, label: '', go: null },
        readSoon: !!v.ss_readSoon,
        user: {
          name: U.name || (U.kind === 'admin' ? U.email : U.rollNo),
          sub: U.kind === 'admin' ? (U.role === 'super_admin' ? 'super admin' : 'admin') + ' · preview' : U.rollNo + (U.batch ? ' · ' + U.batch : ''),
          isAdmin: U.kind === 'admin'
        },
        logout: function () {
          self.ssSaveProgress(true); self.ssSaveDraft(true);
          if (U.kind === 'admin') { location.href = '/admin'; return; }
          api('POST', '/api/auth/logout').then(function () { location.href = '/login'; }, function () { location.href = '/login'; });
        },
        toAdmin: function () { location.href = '/admin'; },
        banner: { on: U.kind === 'admin', text: 'Admin preview: you are viewing the student portal. Your test attempts are not saved to the leaderboard.' },
        toast: { on: !!S.ssToast, text: S.ssToast ? S.ssToast.text : '', ring: S.ssToast && S.ssToast.err ? '#FF7A7A' : '#9BE58B' },
        submit: { pending: !!S.ssSubmitting || (!!v.t.done && !R && !S.ssSubmitErr), failed: !!S.ssSubmitErr && !R, error: S.ssSubmitErr || '', retry: function () { self._ssRetryAt = 0; self.gradeTest(); } },
        result: {
          on: !!R, score: R ? fmtScore(R.score) + ' / ' + fmtScore(R.maxTotal) : '',
          note: R ? (R.textPending ? 'Written problems are marked by the panel. Your total and rank update when marks are added.' : R.autoSubmitted ? 'Auto-submitted when time ran out.' : 'All parts marked.') : ''
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

  api('GET', '/api/bootstrap').then(function (B) {
    clock.offset = B.serverNow - Date.now();
    window.__ssBoot = B;
    bootPortal(SprintPortal, { testMode: B.sprint.preview ? 'preview-open' : 'auto' });
  }, function (e) { if (e.code !== 'AUTH') fail(e.message); });
})();
