// Central configuration. Values come from environment variables (Vercel → Project → Settings → Environment Variables)
// or, locally, from server/.env (see .env.example).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    process.env[m[1]] = v;
  }
}
loadEnv(path.join(ROOT, '.env'));
loadEnv(path.join(ROOT, '.env.local')); // written by `vercel env pull`

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const isVercel = !!env.VERCEL;
const isProd = env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production';
// On Vercel the deployment folder is read-only; only /tmp is writable.
const dataDir = isVercel ? path.join('/tmp', 'sprint-data') : path.resolve(ROOT, env.DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true });

function appSecret() {
  if (env.APP_SECRET && env.APP_SECRET.length >= 32) return env.APP_SECRET;
  if (isProd || isVercel) throw new Error('APP_SECRET must be set (32+ random characters).');
  const f = path.join(dataDir, '.dev-secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'));
  return fs.readFileSync(f, 'utf8').trim();
}

// Test OTPs (code returned in the API response) are for local development and load-testing a STAGING deployment only.
// PRELAUNCH_TEST_MODE=true: the production site may run with on-screen codes while there is no SMS provider yet.
// Turn it OFF (delete the variable) and set a real OTP_PROVIDER before students use the site.
const prelaunch = bool(env.PRELAUNCH_TEST_MODE, false);
const allowTestOtp = (bool(env.ALLOW_TEST_OTP, false) && env.VERCEL_ENV !== 'production') || prelaunch;

export const config = {
  isProd, isVercel,
  port: Number(env.PORT || 3000),
  host: env.HOST || (isProd ? '0.0.0.0' : '127.0.0.1'),
  trustProxy: isVercel ? true : env.TRUST_PROXY ? (/^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY) : false,
  cookieSecure: bool(env.COOKIE_SECURE, isProd || isVercel),
  secret: appSecret(),

  // ---- data stores
  // Postgres (Neon via the Vercel Marketplace sets DATABASE_URL; use the *pooled* connection string).
  databaseUrl: env.DATABASE_URL || env.POSTGRES_URL || '',
  dbPoolMax: Number(env.DB_POOL_MAX || (isVercel ? 5 : 10)),
  pgliteMemory: bool(env.PGLITE_MEMORY, false),
  // Redis: a standard server (REDIS_URL=redis://…) or Upstash over HTTP (KV_REST_API_URL/TOKEN).
  redisTcpUrl: /^rediss?:\/\//.test(env.REDIS_URL || '') ? env.REDIS_URL : '',
  redisUrl: env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || '',
  redisToken: env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || '',
  // Video storage for uploaded learning bytes, picked in this order:
  //   S3-compatible (Cloudflare R2 — free egress, AWS S3, Backblaze B2, MinIO…) → Vercel Blob → local disk.
  s3: {
    endpoint: (env.S3_ENDPOINT || '').replace(/\/$/, ''),       // e.g. https://<account-id>.r2.cloudflarestorage.com
    bucket: env.S3_BUCKET || '',
    region: env.S3_REGION || 'auto',
    accessKeyId: env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
    publicUrl: (env.S3_PUBLIC_URL || '').replace(/\/$/, '')      // e.g. https://videos.example.com (R2 custom domain)
  },
  blobToken: env.BLOB_READ_WRITE_TOKEN || '',
  // Run several Node processes on one machine (uses every CPU core). Needs Postgres + REDIS_URL.
  webConcurrency: Number(env.WEB_CONCURRENCY || 1),
  maxVideoBytes: Number(env.MAX_VIDEO_MB || 500) * 1024 * 1024, // keep under 512 MB so the CDN caches it
  cronSecret: env.CRON_SECRET || '',

  dataDir,
  studentsFile: path.resolve(ROOT, env.STUDENTS_FILE || path.join(ROOT, 'data', 'students.csv')),
  // Build outputs (npm run build). Kept apart from data/ so a mounted data volume never hides them.
  sprintTestFile: path.join(ROOT, 'generated', 'sprint-test.json'),
  lessonsFile: path.join(ROOT, 'generated', 'lessons.json'),
  folderBytesFile: path.join(ROOT, 'generated', 'learning-bytes-folder.json'),
  learningBytesDir: path.join(ROOT, 'public', 'learning-bytes'),
  localUploadsDir: path.join(isVercel ? dataDir : path.resolve(ROOT, env.DATA_DIR || 'data'), 'uploads'),

  otp: {
    provider: (env.OTP_PROVIDER || (prelaunch || !(isProd || isVercel) ? 'console' : '')).toLowerCase(),
    length: 6,
    ttlMs: Number(env.OTP_TTL_SECONDS || 300) * 1000,
    maxVerifyAttempts: 5,
    resendCooldownMs: Number(env.OTP_RESEND_SECONDS || 30) * 1000,
    maxSendsPerHour: Number(env.OTP_MAX_PER_HOUR || 5),
    devShow: (!isProd && !isVercel && bool(env.OTP_DEV_SHOW, true)) || allowTestOtp,
    defaultCountryCode: env.PHONE_COUNTRY_CODE || '91',
    webhookUrl: env.OTP_WEBHOOK_URL || '',
    webhookToken: env.OTP_WEBHOOK_TOKEN || '',
    msg91AuthKey: env.MSG91_AUTH_KEY || '',
    msg91TemplateId: env.MSG91_TEMPLATE_ID || '',
    twilioSid: env.TWILIO_ACCOUNT_SID || '',
    twilioToken: env.TWILIO_AUTH_TOKEN || '',
    twilioFrom: env.TWILIO_FROM || '',
    appName: env.APP_NAME || 'Saturday Sprint'
  },

  session: {
    studentMs: Number(env.STUDENT_SESSION_DAYS || 7) * 86400000,
    adminMs: Number(env.ADMIN_SESSION_HOURS || 8) * 3600000
  },

  admin: {
    requireTotp: bool(env.ADMIN_REQUIRE_TOTP, true),
    maxFailedLogins: 5,
    lockMs: 15 * 60000
  },

  sprint: {
    id: env.SPRINT_ID || 'sprint-2026-10-03',
    open: env.SPRINT_OPEN || '2026-10-03T11:00:00+05:30',
    close: env.SPRINT_CLOSE || '2026-10-03T11:30:00+05:30',
    durationMin: Number(env.SPRINT_DURATION_MIN || 20),
    graceMs: 90 * 1000
  }
};

// The real live site (VERCEL_ENV=production, or NODE_ENV=production off Vercel). Vercel Preview deployments are test sites.
config.prelaunch = prelaunch;
config.isLive = (isVercel ? env.VERCEL_ENV === 'production' : isProd) && !prelaunch;
if ((isProd || isVercel) && !config.otp.provider) {
  throw new Error('OTP_PROVIDER must be set in production (webhook, msg91 or twilio).');
}
if (config.isLive && config.otp.provider === 'console') {
  throw new Error('OTP_PROVIDER=console only prints codes; set a real SMS provider (webhook, msg91 or twilio) for the live site.');
}
// Vercel functions have no permanent disk: without DATABASE_URL every data change would be lost.
if (isVercel && !config.databaseUrl) {
  throw new Error('DATABASE_URL is not set. Connect a Postgres database (e.g. Neon in Vercel → Storage) to this project.');
}
