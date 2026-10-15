// Error alerts (alerts.js): posted to a chat webhook, throttled, never carrying phone numbers or query strings.
//   npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const got = [];
let hook, alerts;
before(async () => {
  hook = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d)).on('end', () => { got.push(JSON.parse(b)); res.end('ok'); });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  process.env.ALERT_WEBHOOK_URL = 'http://127.0.0.1:' + hook.address().port + '/hook';
  alerts = await import('../alerts.js');
});
after(() => hook.close());

const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

test('an error is posted once with where, method and path; no query string, no phone number', async () => {
  alerts._resetForTest(); got.length = 0;
  const sent = await quiet(() => alerts.reportError('http', new TypeError('SMS to +91 98765 43210 failed'), { method: 'POST', url: '/api/sprint/submit?roll=N26P02A0001', id: 'abc1' }));
  assert.equal(sent, true);
  assert.equal(got.length, 1);
  const t = got[0].text;
  assert.match(t, /server error in http/);
  assert.match(t, /POST \/api\/sprint\/submit/);
  assert.match(t, /TypeError: SMS to \[number\] failed/);
  assert.match(t, /ref abc1/);
  assert.ok(!t.includes('98765') && !t.includes('roll='), 'no phone digits, no query string');
  assert.equal(got[0].content, t, 'Discord field carries the same text');
});

test('the same error repeats are held back for 10 minutes; a different error still goes out', async () => {
  alerts._resetForTest(); got.length = 0;
  await quiet(async () => {
    for (let i = 0; i < 5; i++) await alerts.reportError('auto-submit', new Error('database timeout'));
    await alerts.reportError('auto-submit', new Error('something else'));
  });
  assert.deepEqual(got.map((g) => g.text.split('\n').pop()), ['Error: database timeout', 'Error: something else']);
});

test('at most 20 alerts per hour', async () => {
  alerts._resetForTest(); got.length = 0;
  await quiet(async () => { for (let i = 0; i < 30; i++) await alerts.reportError('http', new Error('distinct ' + i)); });
  assert.equal(got.length, 20);
});

test('a webhook that is down never throws into the request', async () => {
  alerts._resetForTest();
  const url = process.env.ALERT_WEBHOOK_URL;
  const { config } = await import('../config.js');
  config.alerts.webhookUrl = 'http://127.0.0.1:9/unreachable';
  try { assert.equal(await quiet(() => alerts.reportError('http', new Error('x'))), false); }
  finally { config.alerts.webhookUrl = url; }
});
