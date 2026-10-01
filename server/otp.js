// OTP delivery. Pick a provider with OTP_PROVIDER in .env:
//   console  development only: prints the code in the server log (and shows it on the login screen)
//   webhook  POSTs {phone, code, message} as JSON to OTP_WEBHOOK_URL (use your LMS's existing SMS service)
//   msg91    MSG91 OTP API (needs a DLT-approved template that contains ##OTP##)
//   twilio   Twilio Programmable SMS
import { config } from './config.js';

const O = config.otp;
const minutes = () => Math.round(O.ttlMs / 60000);
const message = (code) => `${code} is your ${O.appName} verification code. It expires in ${minutes()} minutes. Do not share it with anyone.`;

async function check(res, label) {
  if (res.ok) return;
  let body = '';
  try { body = (await res.text()).slice(0, 300); } catch {}
  throw new Error(`${label} responded ${res.status}: ${body}`);
}

const providers = {
  async console(phone, code) {
    console.log(`[otp] ${phone} → ${code}`);
  },
  async webhook(phone, code) {
    if (!O.webhookUrl) throw new Error('OTP_WEBHOOK_URL is not set');
    const res = await fetch(O.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(O.webhookToken ? { authorization: 'Bearer ' + O.webhookToken } : {}) },
      body: JSON.stringify({ phone, code, message: message(code), ttlSeconds: O.ttlMs / 1000 }),
      signal: AbortSignal.timeout(10000)
    });
    await check(res, 'OTP webhook');
  },
  async msg91(phone, code) {
    if (!O.msg91AuthKey || !O.msg91TemplateId) throw new Error('MSG91_AUTH_KEY and MSG91_TEMPLATE_ID must be set');
    const u = new URL('https://control.msg91.com/api/v5/otp');
    u.searchParams.set('template_id', O.msg91TemplateId);
    u.searchParams.set('mobile', phone.replace(/^\+/, ''));
    u.searchParams.set('otp', code);
    u.searchParams.set('otp_expiry', String(minutes()));
    const res = await fetch(u, { method: 'POST', headers: { authkey: O.msg91AuthKey, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) });
    await check(res, 'MSG91');
    const j = await res.json().catch(() => ({}));
    if (j && j.type === 'error') throw new Error('MSG91: ' + (j.message || 'error'));
  },
  async twilio(phone, code) {
    if (!O.twilioSid || !O.twilioToken || !O.twilioFrom) throw new Error('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM must be set');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${O.twilioSid}/Messages.json`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(O.twilioSid + ':' + O.twilioToken).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: phone, From: O.twilioFrom, Body: message(code) }),
      signal: AbortSignal.timeout(10000)
    });
    await check(res, 'Twilio');
  }
};

export async function deliverOtp(phone, code) {
  const p = providers[O.provider];
  if (!p) throw new Error('Unknown OTP_PROVIDER "' + O.provider + '"');
  await p(phone, code);
}
