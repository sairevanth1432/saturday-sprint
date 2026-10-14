/* Saturday Sprint · festival layer.
 *
 * Dussehra 2026: between 14 and 22 Oct 2026 (IST) the portal, the login page and the help page get:
 *   - a marigold toran hanging from the two top corners (sways and bobs on the portal's Home tab, still elsewhere),
 *   - a marigold shower when the portal opens (once per browser session; click the greeting card to replay),
 *   - on login/help: two diyas in the bottom-left corner,
 *   - on the portal's Home tab: a greeting card (markup in saturday_sprint_portal*.html, {{ festive.* }});
 *     its arrow fires every few seconds, hovering it throws sparks off the arrow tip,
 *   - on every page: moving the pointer leaves a short trail of gold stars.
 *
 * The original dark + yellow look stays; everything here is layered on top, decorative only
 * (aria-hidden, no pointer events, hidden when printing, no motion under prefers-reduced-motion).
 *
 * Preview on any day with ?festive=1, hide with ?festive=0. Outside the window the script does nothing.
 * Next festival: change FEST below (dates are inclusive, IST).
 */
(function () {
  'use strict';

  var FEST = {
    name: 'Dussehra',
    from: '2026-10-14',
    to: '2026-10-22',
    title: 'Happy Vijayadashami',
    line: 'Good over evil, practice over doubt.',
    line1: 'Good over evil,',
    line2: 'practice over doubt.'
  };

  function istToday() { return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); } // UTC+5:30
  var q = /[?&]festive=([01])/.exec(location.search);
  var today = istToday();
  var on = q ? q[1] === '1' : (today >= FEST.from && today <= FEST.to);

  window.SSFestive = { on: on, name: FEST.name, title: FEST.title, line: FEST.line, line1: FEST.line1, line2: FEST.line2, from: FEST.from, to: FEST.to };
  if (!on) return;

  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------- styles
  var CSS = [
    '.ss-fest{position:fixed;pointer-events:none;z-index:35}',
    /* toran: one swag per top corner */
    '.ss-toran{top:0;width:300px;height:56px}',
    '.ss-toran.l{left:0;transform-origin:0 0}',
    '.ss-toran.r{right:0;transform-origin:100% 0}',
    '.ss-toran svg{display:block;width:300px;height:56px;overflow:visible}',
    /* the garland moves only while the portal shows Home (html.ss-home); static everywhere else */
    '.ss-home .ss-toran.l{animation:ss-sway-l 5s ease-in-out infinite alternate}',
    '.ss-home .ss-toran.r{animation:ss-sway-r 5s ease-in-out infinite alternate;animation-delay:-2.5s}',
    '.ss-home .ss-toran svg{animation:ss-bob 2.8s ease-in-out infinite alternate}',
    '.ss-home .ss-toran.r svg{animation-delay:-1.4s}',
    '@keyframes ss-sway-l{from{transform:rotate(-1.6deg)}to{transform:rotate(1.6deg)}}',
    '@keyframes ss-sway-r{from{transform:rotate(1.6deg)}to{transform:rotate(-1.6deg)}}',
    '@keyframes ss-bob{from{transform:translateY(0)}to{transform:translateY(3px)}}',
    /* diyas (login + help) */
    '.ss-diyas{left:18px;bottom:14px;display:flex;gap:8px;align-items:flex-end}',
    '.ss-diya{width:34px;height:36px;display:block}',
    '.ss-flame{transform-box:fill-box;transform-origin:50% 100%;animation:ss-flicker 1.6s ease-in-out infinite alternate}',
    '.ss-diya+.ss-diya .ss-flame,.ss-diya+.ss-diya .ss-glow{animation-duration:1.9s;animation-delay:-.8s}',
    '.ss-glow{animation:ss-glow 1.6s ease-in-out infinite alternate}',
    '@keyframes ss-flicker{0%{transform:scale(1,1) rotate(-2deg)}50%{transform:scale(1.05,1.12) rotate(1.5deg)}100%{transform:scale(.96,1.03) rotate(-1deg)}}',
    '@keyframes ss-glow{from{opacity:.4}to{opacity:.85}}',
    /* greeting card (portal Home) */
    '#ss-greet{cursor:pointer;transition:transform 220ms ease}',
    '#ss-greet:hover{transform:translateY(-1px)}',
    '#ss-greet .ss-bow{filter:drop-shadow(0 0 0 rgba(255,228,92,0));transition:filter 220ms ease}',
    '#ss-greet:hover .ss-bow{filter:drop-shadow(0 0 6px rgba(255,228,92,.75))}',
    '#ss-greet .ss-mandala{transform-box:fill-box;transform-origin:center;animation:ss-spin 90s linear infinite}',
    /* one 6 s cycle: the bow draws (string plucks), the arrow flies across the card, the title types out as it flies, Ravana bursts on impact, the two lines appear, then everything resets */
    '#ss-greet .ss-arrow{animation:ss-bowarrow 6s linear infinite}',
    '#ss-greet .ss-string{animation:ss-pluck 6s ease-out infinite}',
    '#ss-greet .ss-fly{position:absolute;top:50%;left:88px;margin-top:-7px;opacity:0;pointer-events:none;animation:ss-fly 6s linear infinite}',
    '#ss-greet .ss-ravana{flex-shrink:0;overflow:visible}',
    '#ss-greet .ss-rv-body{transform-box:fill-box;transform-origin:center;animation:ss-ravana 6s ease-out infinite}',
    '#ss-greet .ss-boom{position:absolute;pointer-events:none}',
    '#ss-greet .ss-type{display:inline-block;overflow:hidden;white-space:nowrap;width:auto;animation:ss-type 6s linear infinite}',
    '#ss-greet .ss-g1,#ss-greet .ss-g2{animation:ss-lines 6s linear infinite}',
    '@keyframes ss-bowarrow{0%,12%{transform:translateX(0);opacity:1}13%{transform:translateX(-7px);opacity:1}14%{opacity:0}88%{opacity:0;transform:translateX(0)}92%,100%{opacity:1;transform:translateX(0)}}',
    '@keyframes ss-fly{0%,13%{left:88px;opacity:0}14%{opacity:1}33%{left:calc(100% - 92px);opacity:1}34%,100%{left:calc(100% - 92px);opacity:0}}',
    '@keyframes ss-ravana{0%,33%{transform:scale(1);opacity:1;filter:none}36%{transform:scale(1.25) rotate(-6deg);opacity:.9;filter:brightness(3)}42%{transform:scale(1.6) rotate(8deg);opacity:0}78%{transform:scale(.9);opacity:0}90%,100%{transform:scale(1);opacity:1}}',
    '@keyframes ss-type{0%,13%{max-width:0;animation-timing-function:steps(24,end)}33%{max-width:30ch}92%{max-width:30ch}100%{max-width:0}}',
    '@keyframes ss-lines{0%,35%{opacity:0;transform:translateY(4px)}44%{opacity:1;transform:none}92%{opacity:1}100%{opacity:0}}',
    '@keyframes ss-boom{0%{transform:translate(-50%,-50%) scale(.2);opacity:1}100%{transform:translate(calc(-50% + var(--bx)),calc(-50% + var(--by))) scale(1);opacity:0}}',
    '#ss-greet .ss-tw{transform-box:fill-box;transform-origin:center;animation:ss-twinkle 2.4s ease-in-out infinite}',
    '#ss-greet .ss-tw.b{animation-delay:-.8s}#ss-greet .ss-tw.c{animation-delay:-1.6s}',
    '@keyframes ss-spin{to{transform:rotate(360deg)}}',
    /* watermark mandala under the portal content (markup in the portal template) */
    '.ss-wm{display:block;transform-box:fill-box;transform-origin:center;animation:ss-spin 240s linear infinite}',
    '.ss-tw{transform-box:fill-box;transform-origin:center;animation:ss-twinkle 2.4s ease-in-out infinite}',
    '.ss-tw.b{animation-delay:-.8s}.ss-tw.c{animation-delay:-1.6s}',
    '@keyframes ss-shoot{0%,18%{transform:translateX(0);opacity:1}26%{transform:translateX(-7px);opacity:1}30%{transform:translateX(-7px)}48%{transform:translateX(42px);opacity:0}49%{transform:translateX(-18px);opacity:0}70%{transform:translateX(0);opacity:1}100%{transform:translateX(0);opacity:1}}',
    '@keyframes ss-pluck{0%,26%{transform:translateX(0)}29%{transform:translateX(-5px)}33%{transform:translateX(2px)}37%{transform:translateX(-1px)}41%,100%{transform:translateX(0)}}',
    '@keyframes ss-twinkle{0%,100%{opacity:.15;transform:scale(.6)}50%{opacity:1;transform:scale(1)}}',
    /* sparks off the arrow tip (hover) */
    '.ss-spark{position:fixed;width:5px;height:5px;border-radius:50%;pointer-events:none;z-index:45;animation:ss-spark 700ms cubic-bezier(.2,.7,.3,1) forwards}',
    '@keyframes ss-spark{0%{transform:translate(0,0) scale(1);opacity:1}100%{transform:translate(var(--dx),var(--dy)) scale(.2);opacity:0}}',
    /* cursor sparkle trail on the portal's Home tab */
    '.ss-trail{position:fixed;width:12px;height:12px;pointer-events:none;z-index:45;animation:ss-trail 750ms ease-out forwards}',
    '.ss-trail svg{display:block;width:100%;height:100%}',
    '@keyframes ss-trail{0%{transform:translate(-50%,-50%) scale(.35) rotate(0);opacity:1}100%{transform:translate(-50%,calc(-50% - 22px)) scale(1) rotate(100deg);opacity:0}}',
    /* marigold shower */
    '.ss-rain{position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:34}',
    '.ss-petal{position:absolute;top:-24px;animation:ss-fall var(--t) linear var(--d) forwards;opacity:0}',
    '.ss-petal svg{display:block;animation:ss-drift var(--s) ease-in-out infinite alternate}',
    '@keyframes ss-fall{0%{transform:translateY(0) rotate(0);opacity:0}6%{opacity:1}90%{opacity:1}100%{transform:translateY(110vh) rotate(var(--r));opacity:0}}',
    '@keyframes ss-drift{from{transform:translateX(-14px)}to{transform:translateX(14px)}}',
    '@media (prefers-reduced-motion:reduce){.ss-toran,.ss-toran svg,.ss-flame,.ss-glow,#ss-greet .ss-mandala,#ss-greet .ss-arrow,#ss-greet .ss-string,#ss-greet .ss-tw,#ss-greet .ss-fly,#ss-greet .ss-rv-body,#ss-greet .ss-type,#ss-greet .ss-g1,#ss-greet .ss-g2{animation:none}#ss-greet .ss-tw{opacity:.7}#ss-greet .ss-type{max-width:none}#ss-greet .ss-g1,#ss-greet .ss-g2{opacity:1}}',
    '@media (max-width:640px){.ss-diyas{display:none}.ss-toran{width:200px}}',
    '@media print{.ss-fest,.ss-rain,.ss-spark,.ss-trail{display:none}}'
  ].join('\n');

  // ---------------------------------------------------------------- svg pieces
  var SYMBOLS =
    '<symbol id="ss-mo" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.4" fill="#E8690B"/><circle cx="7" cy="7" r="6" fill="none" stroke="#FB9B2B" stroke-width="1.8" stroke-dasharray="1.5 1.3"/><circle cx="7" cy="7" r="3.8" fill="#FFA726"/><circle cx="7" cy="7" r="1.7" fill="#FFE45C"/></symbol>' +
    '<symbol id="ss-my" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.4" fill="#E9A80C"/><circle cx="7" cy="7" r="6" fill="none" stroke="#FFC93C" stroke-width="1.8" stroke-dasharray="1.5 1.3"/><circle cx="7" cy="7" r="3.8" fill="#FFD54A"/><circle cx="7" cy="7" r="1.7" fill="#FFF3B0"/></symbol>' +
    '<symbol id="ss-lf" viewBox="0 0 8 14"><path d="M4 0C6.6 3 7 8 4 13.6 1 8 1.4 3 4 0Z" fill="#3F8F3F"/><path d="M4 1.5V12" stroke="#2C6B2C" stroke-width=".8"/></symbol>';

  function use(id, cx, cy, size) {
    return '<use href="#' + id + '" x="' + (cx - size / 2).toFixed(1) + '" y="' + (cy - size / 2).toFixed(1) + '" width="' + size + '" height="' + size + '"/>';
  }
  function leaf(cx, top, h) {
    return '<use href="#ss-lf" x="' + (cx - 4).toFixed(1) + '" y="' + top.toFixed(1) + '" width="8" height="' + h + '"/>';
  }
  // A swag: gold thread from (x0,2) to (x1,2) dipping by `dip`; `n` marigolds along it; leaves at the given t values.
  function swag(x0, x1, dip, n, leafAt) {
    var cx = (x0 + x1) / 2, cy = 2 + 2 * dip; // quadratic control point → lowest point is 2 + dip
    var s = '<path d="M' + x0 + ' 2Q' + cx + ' ' + cy + ' ' + x1 + ' 2" fill="none" stroke="#C9A227" stroke-width="1.4"/>';
    var yAt = function (t) { return 2 + 4 * dip * t * (1 - t); };
    var xAt = function (t) { return x0 + (x1 - x0) * t; };
    leafAt.forEach(function (t) { s += leaf(xAt(t), yAt(t) + 3, t === 0.5 ? 14 : 11); });
    for (var i = 1; i <= n; i++) {
      var t = i / (n + 1), big = i % 2 === 1;
      s += use(big ? 'ss-mo' : 'ss-my', xAt(t), yAt(t), big ? 14 : 11);
    }
    return s;
  }
  var TORAN_BODY =
    swag(0, 200, 26, 8, [0.25, 0.5, 0.75]) + swag(200, 290, 15, 3, [0.5]) +
    use('ss-my', 0, 2, 12) + use('ss-my', 200, 2, 12) + use('ss-my', 290, 2, 12);
  function toran(mirror) { // the right corner is the left one flipped inside the SVG (keeps CSS transforms free for motion)
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 56" aria-hidden="true" focusable="false"><defs>' + SYMBOLS + '</defs>' +
      '<g' + (mirror ? ' transform="matrix(-1 0 0 1 300 0)"' : '') + '>' + TORAN_BODY + '</g></svg>';
  }

  function diya(id) {
    return '<svg class="ss-diya" viewBox="0 0 36 38" aria-hidden="true" focusable="false">' +
      '<defs><radialGradient id="' + id + '"><stop offset="0" stop-color="#FFE45C" stop-opacity=".55"/><stop offset="1" stop-color="#FFE45C" stop-opacity="0"/></radialGradient></defs>' +
      '<circle class="ss-glow" cx="18" cy="14" r="13" fill="url(#' + id + ')"/>' +
      '<g class="ss-flame">' +
      '<path d="M18 3.5C22.2 8.5 23.4 13 21.4 17.8 20.4 20.6 15.6 20.6 14.6 17.8 12.6 13 13.8 8.5 18 3.5Z" fill="#FF9F1C"/>' +
      '<path d="M18 8.5C20.3 11.6 20.9 14.8 19.8 18 19.2 19.6 16.8 19.6 16.2 18 15.1 14.8 15.7 11.6 18 8.5Z" fill="#FFE45C"/>' +
      '<path d="M18 13C19.1 14.8 19.2 16.6 18.4 18.3 18.1 18.9 17.4 18.8 17.2 18.2 16.7 16.5 17 14.8 18 13Z" fill="#FFF8D6"/>' +
      '</g>' +
      '<rect x="17.3" y="18.5" width="1.4" height="4" fill="#3A2A1A"/>' +
      '<ellipse cx="18" cy="23.5" rx="12" ry="3" fill="#D9682A"/>' +
      '<ellipse cx="18" cy="23.5" rx="9" ry="1.8" fill="#8A3A12"/>' +
      '<path d="M6 24H30L27 31.5C21 34.5 15 34.5 9 31.5Z" fill="#B5541C"/>' +
      '<path d="M11.5 32.5H24.5L23.5 35.5H12.5Z" fill="#8A3A12"/>' +
      '</svg>';
  }

  var PETAL_O = '<svg viewBox="0 0 14 14" width="SZ" height="SZ"><circle cx="7" cy="7" r="6.4" fill="#E8690B"/><circle cx="7" cy="7" r="6" fill="none" stroke="#FB9B2B" stroke-width="1.8" stroke-dasharray="1.5 1.3"/><circle cx="7" cy="7" r="3.8" fill="#FFA726"/><circle cx="7" cy="7" r="1.7" fill="#FFE45C"/></svg>';
  var PETAL_Y = '<svg viewBox="0 0 14 14" width="SZ" height="SZ"><circle cx="7" cy="7" r="6.4" fill="#E9A80C"/><circle cx="7" cy="7" r="6" fill="none" stroke="#FFC93C" stroke-width="1.8" stroke-dasharray="1.5 1.3"/><circle cx="7" cy="7" r="3.8" fill="#FFD54A"/><circle cx="7" cy="7" r="1.7" fill="#FFF3B0"/></svg>';
  var PETAL_L = '<svg viewBox="0 0 8 14" width="SZH" height="SZ"><path d="M4 0C6.6 3 7 8 4 13.6 1 8 1.4 3 4 0Z" fill="#3F8F3F"/></svg>';

  // ---------------------------------------------------------------- effects
  function shower() {
    if (REDUCED || document.querySelector('.ss-rain')) return;
    var box = document.createElement('div');
    box.className = 'ss-rain';
    box.setAttribute('aria-hidden', 'true');
    var html = '';
    for (var i = 0; i < 42; i++) {
      var kind = i % 5 === 4 ? PETAL_L : i % 2 ? PETAL_Y : PETAL_O;
      var sz = 10 + Math.round(Math.random() * 8);
      var svg = kind.replace(/SZH/g, String(Math.round(sz * 0.57))).replace(/SZ/g, String(sz));
      html += '<span class="ss-petal" style="left:' + (Math.random() * 100).toFixed(1) + '%;--t:' + (3.6 + Math.random() * 2.6).toFixed(2) + 's;--d:' +
        (Math.random() * 2.2).toFixed(2) + 's;--s:' + (1.4 + Math.random() * 1.2).toFixed(2) + 's;--r:' + Math.round(240 + Math.random() * 480) + 'deg">' + svg + '</span>';
    }
    box.innerHTML = html;
    document.body.appendChild(box);
    setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 9000);
  }

  var sparkAt = 0;
  function sparks(card) {
    if (REDUCED) return;
    var now = Date.now();
    if (now - sparkAt < 450) return;
    sparkAt = now;
    var tip = card.querySelector('.ss-tip') || card;
    var r = tip.getBoundingClientRect();
    var x = r.left + r.width * 0.85, y = r.top + r.height / 2;
    var colours = ['#FFE45C', '#FFA726', '#FF7A1A', '#FFF3B0'];
    for (var i = 0; i < 14; i++) {
      var s = document.createElement('i');
      var a = (Math.random() - 0.5) * Math.PI * 0.9, d = 26 + Math.random() * 40; // a fan to the right
      s.className = 'ss-spark';
      s.style.cssText = 'left:' + x + 'px;top:' + y + 'px;background:' + colours[i % colours.length] +
        ';--dx:' + (Math.cos(a) * d).toFixed(1) + 'px;--dy:' + (Math.sin(a) * d - 6).toFixed(1) + 'px';
      document.body.appendChild(s);
      setTimeout(function (el) { if (el.parentNode) el.parentNode.removeChild(el); }, 750, s);
    }
  }

  // Cursor trail: a tiny gold star where the pointer moves, on every page (the greeting card has its own sparks).
  var STAR = '<svg viewBox="-6 -6 12 12" aria-hidden="true"><path d="M0-5.5L1.3-1.3 5.5 0 1.3 1.3 0 5.5-1.3 1.3-5.5 0-1.3-1.3Z" fill="currentColor"/></svg>';
  var trailX = -99, trailY = -99, trailAt = 0, trailLive = 0;
  function trail(e) {
    if (REDUCED || trailLive > 28) return;
    if (e.target && e.target.closest && e.target.closest('#ss-greet')) return; // the card has its own sparks
    var now = Date.now(), dx = e.clientX - trailX, dy = e.clientY - trailY;
    if (now - trailAt < 40 || dx * dx + dy * dy < 26 * 26) return;
    trailAt = now; trailX = e.clientX; trailY = e.clientY;
    var s = document.createElement('i');
    s.className = 'ss-trail';
    s.style.cssText = 'left:' + (e.clientX + (Math.random() - 0.5) * 14).toFixed(0) + 'px;top:' + (e.clientY + (Math.random() - 0.5) * 14).toFixed(0) +
      'px;color:' + (Math.random() < 0.7 ? '#FFE45C' : '#FFA726') + ';width:' + (8 + Math.random() * 6).toFixed(0) + 'px;height:' + (8 + Math.random() * 6).toFixed(0) + 'px';
    s.innerHTML = STAR;
    document.body.appendChild(s);
    trailLive++;
    setTimeout(function (el) { trailLive--; if (el.parentNode) el.parentNode.removeChild(el); }, 800, s);
  }

  // Impact: a burst of sparks on Ravana each time the arrow lands (every 6 s, 2 s into the cycle), synced to the CSS timeline.
  function boomLoop() {
    if (REDUCED) return;
    var card = document.getElementById('ss-greet'), rv = card && card.querySelector('.ss-ravana');
    if (card && rv) {
      var r = rv.getBoundingClientRect(), c = card.getBoundingClientRect(), x = r.left - c.left + r.width / 2, y = r.top - c.top + r.height / 2;
      var colours = ['#FFE45C', '#FF7A1A', '#FFA726', '#E53935', '#FFF3B0'];
      for (var i = 0; i < 16; i++) {
        var a = Math.random() * Math.PI * 2, d = 30 + Math.random() * 50, s = document.createElement('i');
        s.className = 'ss-boom';
        s.style.cssText = 'left:' + x + 'px;top:' + y + 'px;width:' + (4 + Math.random() * 5) + 'px;height:' + (4 + Math.random() * 5) + 'px;border-radius:' + (Math.random() < 0.5 ? '50%' : '1px') + ';background:' + colours[i % colours.length] +
          ';--bx:' + (Math.cos(a) * d).toFixed(0) + 'px;--by:' + (Math.sin(a) * d - 10).toFixed(0) + 'px;animation:ss-boom ' + (500 + Math.random() * 400).toFixed(0) + 'ms cubic-bezier(.2,.7,.3,1) forwards';
        card.appendChild(s);
        setTimeout(function (el) { if (el.parentNode) el.parentNode.removeChild(el); }, 1000, s);
      }
    }
  }
  // The CSS animations start when the card mounts; align the bursts to 33% of the 6 s cycle from the first time the card is seen.
  var boomT = null;
  function watchGreet() {
    var card = document.getElementById('ss-greet');
    if (card && !boomT) { boomT = setTimeout(function () { boomLoop(); boomT = setInterval(boomLoop, 6000); }, 2000); }
    if (!card && boomT) { clearTimeout(boomT); clearInterval(boomT); boomT = null; }
  }

  // ---------------------------------------------------------------- mount
  function mount() {
    if (document.getElementById('ss-fest-style')) return;
    var isPortal = !!document.getElementById('app');
    document.documentElement.classList.add('ss-festive');
    var st = document.createElement('style');
    st.id = 'ss-fest-style';
    st.textContent = CSS;
    document.head.appendChild(st);

    ['l', 'r'].forEach(function (side) {
      var t = document.createElement('div');
      t.className = 'ss-fest ss-toran ' + side;
      t.setAttribute('aria-hidden', 'true');
      t.innerHTML = toran(side === 'r');
      document.body.appendChild(t);
    });

    // html.ss-home while the portal shows its Home tab (the greeting card is in the DOM): the garland moves only then.
    if (isPortal) {
      var app = document.getElementById('app');
      var sync = function () { document.documentElement.classList.toggle('ss-home', !!document.getElementById('ss-greet')); };
      sync();
      if (window.MutationObserver) new MutationObserver(function () { sync(); watchGreet(); }).observe(app, { childList: true, subtree: true });
      watchGreet();
    }

    if (!isPortal) {
      var diyas = document.createElement('div');
      diyas.className = 'ss-fest ss-diyas';
      diyas.setAttribute('aria-hidden', 'true');
      diyas.innerHTML = diya('ss-dg1') + diya('ss-dg2');
      document.body.appendChild(diyas);
    }

    // Greeting card: the portal re-renders its template, so listen on the document instead of the card.
    document.addEventListener('mouseover', function (e) {
      var card = e.target && e.target.closest && e.target.closest('#ss-greet');
      if (card) sparks(card);
    });
    document.addEventListener('click', function (e) {
      var card = e.target && e.target.closest && e.target.closest('#ss-greet');
      if (card) { sparks(card); shower(); }
    });

    document.addEventListener('mousemove', trail, { passive: true });

    if (isPortal) {
      var key = 'ss-shower-' + FEST.from;
      var seen = false;
      try { seen = sessionStorage.getItem(key) === '1'; } catch (err) {}
      if (!seen) {
        try { sessionStorage.setItem(key, '1'); } catch (err) {}
        setTimeout(shower, 700);
      }
    }
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
