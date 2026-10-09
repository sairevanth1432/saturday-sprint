// Error alerts. Every unexpected server error is written to the log as one JSON line (searchable in Vercel → Logs
// or `docker compose logs`), and, when ALERT_WEBHOOK_URL is set, posted to the team's chat so a failure during a
// live Sprint is seen within seconds instead of through student complaints.
//
//   ALERT_WEBHOOK_URL   incoming-webhook URL: Slack, Microsoft Teams, Discord or Google Chat (all accept this JSON)
//
// What is sent: where it happened, the HTTP method and path (no query string), the error type and message.
// Never sent: cookies, request bodies, phone numbers, OTPs or stack traces (stacks stay in the server log).
// Throttled per instance: the same error at most once per 10 minutes, at most 20 alerts per hour;
// suppressed repeats are counted and reported with the next alert.
import { config } from './config.js';

const REPEAT_MS = 10 * 60 * 1000;
const MAX_PER_HOUR = 20;
const seen = new Map(); // signature → { at, suppressed }
let hourStart = 0, sentThisHour = 0, droppedThisHour = 0;

const short = (s, n) => (String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));
const pathOnly = (url) => String(url || '').split('?')[0];
// Phone numbers and other long digit runs (an SMS provider's error can quote the number) never leave the server.
const masked = (s) => String(s || '').replace(/\+?\d[\d ().-]{5,}\d/g, '[number]');

// where: a short label such as 'http', 'auto-submit', 'process'. ctx: { method, url, id } (all optional).
export function reportError(where, err, ctx = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  const line = { level: 'error', at: new Date().toISOString(), where, method: ctx.method, path: pathOnly(ctx.url), id: ctx.id,
    error: e.name, message: e.message, stack: e.stack };
  try { console.error(JSON.stringify(line)); } catch { console.error('[error]', where, e); }
  return notify(where, e, ctx);
}

function notify(where, e, ctx) {
  if (!config.alerts.webhookUrl) return Promise.resolve(false);
  const now = Date.now();
  if (now - hourStart > 3600000) { hourStart = now; sentThisHour = 0; droppedThisHour = 0; }
  const sig = where + '|' + (ctx.method || '') + ' ' + pathOnly(ctx.url) + '|' + e.name + ': ' + short(masked(e.message), 120);
  const s = seen.get(sig);
  if (s && now - s.at < REPEAT_MS) { s.suppressed++; return Promise.resolve(false); }
  if (sentThisHour >= MAX_PER_HOUR) { droppedThisHour++; return Promise.resolve(false); }
  const repeats = s ? s.suppressed : 0;
  if (seen.size > 500) seen.clear();
  seen.set(sig, { at: now, suppressed: 0 });
  sentThisHour++;
  const text = [
    `[ALERT] ${config.otp.appName} (${config.alerts.site}${process.env.VERCEL_REGION ? ', ' + process.env.VERCEL_REGION : ''}): server error in ${where}`,
    ctx.method || ctx.url ? `${ctx.method || ''} ${pathOnly(ctx.url)}`.trim() : '',
    `${e.name}: ${short(masked(e.message), 300)}`,
    ctx.id ? `ref ${ctx.id}` : '',
    repeats ? `(also happened ${repeats} more time${repeats === 1 ? '' : 's'} in the last 10 min)` : '',
    droppedThisHour ? `(${droppedThisHour} other alert${droppedThisHour === 1 ? '' : 's'} held back this hour)` : ''
  ].filter(Boolean).join('\n');
  // `text`: Slack, Teams, Google Chat. `content`: Discord. A failed alert never affects the request.
  return fetch(config.alerts.webhookUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, content: short(text, 1900) }), signal: AbortSignal.timeout(4000)
  }).then((r) => r.ok, (x) => { console.error('[alerts] webhook failed:', x.message); return false; });
}

// Errors outside any request. A rejected promise nobody handled is reported and the server keeps serving
// (Node would otherwise stop the whole process mid-Sprint). An uncaught exception leaves the process in an
// unknown state, so it is reported and the process exits; Docker/cluster restart it, Vercel starts a new instance.
let installed = false;
export function installProcessHandlers() {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', (reason) => { reportError('unhandled promise', reason); });
  process.on('uncaughtException', (err) => {
    const done = () => process.exit(1);
    setTimeout(done, 3000).unref();
    reportError('uncaught exception', err).then(done, done);
  });
}

export const _resetForTest = () => { seen.clear(); hourStart = 0; sentThisHour = 0; droppedThisHour = 0; };
