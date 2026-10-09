# Saturday Sprint · server

Student login (NIAT ID + OTP), admin console, server-graded End-of-Sprint Test, leaderboard and **learning-byte videos**. Built for **~15,000 simultaneous students**. It runs on **any platform**: Docker on any Linux VM (including a free Oracle Cloud VM + Cloudflare R2), Vercel, or a single `npm start`. See **[HOSTING.md](HOSTING.md)** for the options, **[DEPLOY.md](DEPLOY.md)** to deploy step by step, and **[CHANGES.md](CHANGES.md)** to make changes once it is live.

```
Student → NIAT ID (must be in the master list) + own phone → OTP to that phone → admin approves → log in with NIAT ID + OTP → portal
Admin   → /admin → email + password + authenticator app → full data access and controls
```

## Architecture

```
                 ┌──────────────────────── Vercel CDN (global edge) ────────────────────────┐
 15k browsers ──►│ portal.html · login.html · admin.html · JS        (static, cached, gzip) │
                 │ /learning-bytes/*.mp4  (folder videos)                                    │
                 └───────────────┬───────────────────────────────────────────────────────────┘
                                 │ /api/*
                 ┌───────────────▼────────────────┐       ┌──────────────────────────────┐
                 │ Vercel Function (Express app)   │──────►│ Upstash Redis                │
                 │ auto-scales to 30,000 concurrent│       │ rate limits · autosave drafts│
                 │ Fluid compute · region bom1     │       │ leaderboard cache · locks    │
                 │ grader worker threads (Python)  │       └──────────────────────────────┘
                 └───────────────┬────────────────┘       ┌──────────────────────────────┐
                                 │ pooled connections ───►│ Neon Postgres (pooler)       │
                                 │                         │ students · accounts · results│
   Vercel Cron (every minute) ───┘ auto-submit expired     └──────────────────────────────┘
   Admin uploads MP4 ─────────────────────────────────────► Vercel Blob (public) ──► CDN ──► students
```

| Concern at 15k students | How it is handled |
|---|---|
| Video bandwidth (15k × ~1–2 Mbps) | Videos never pass through the app. **Vercel Blob → CDN** (or the `public/` folder → CDN). Uploads go browser → Blob directly. |
| Portal page burst at 11:00 (1.8 MB each) | Static on the CDN with compression. It holds no answers, so it is safe to cache. |
| App servers crashing or overloading | No single server: each request runs in an auto-scaling Vercel Function. Nothing is kept in memory between requests that matters. |
| Database connections from thousands of functions | Neon's **pooled** endpoint (PgBouncer, 10,000 client connections) plus a small pool per instance (`DB_POOL_MAX=5`). |
| Autosave (15k students) | Every 15 s with jitter, **only if changed** (~1,000/s). Stored in **Redis**, not Postgres; Postgres is written once at submit. |
| Submit spike at the deadline | Automatic submissions are spread over 20 s by the browser. The server accepts them for 90 s after the deadline. Grading is CPU-light (~10–100 ms). |
| Leaderboard polling | The top 100 are computed **once per 5 s across all instances** (Redis) and also cached in each instance. A student's own rank is one indexed count query, cached 10 s. |
| Session checks on every request | Cached per instance for 30 s. Admin sessions are always checked against the database. |
| Abuse / brute force | Redis-backed rate limits shared across instances. OTP lockout after 5 wrong tries. Optionally enable Vercel Firewall rules. |
| Lost connection or closed tab | Drafts autosave. Vercel Cron auto-submits expired attempts every minute from the last autosave. |
| Answers leaking | Questions with answers live only in the function bundle (`data/sprint-test.json`). Students get questions only after starting. |

### Request budget at peak (15,000 students, 30-minute Sprint)

| Traffic | Rate |
|---|---|
| Start burst (11:00–11:03) | ~100–250 req/s (`/sprint/start` + `/bootstrap`) |
| Autosave during the test | ~900 req/s → Redis |
| Submit window (20 s spread) | ~750 req/s, each graded once |
| Leaderboard after submit | ~500 req/s → cache hits |
| Postgres | Low hundreds of queries/s, plus a short write burst at submit (one UPDATE per student) |

## Learning bytes (videos)

One MP4 per lesson. It **replaces that lesson's animated explainer** in the same place, with the same concept and progress tracking. Lessons without a video keep the explainer. There are 20 lessons (IDs such as `pl`, `morph`, `clear`, `few`); see **Admin → Learning bytes** or `data/lessons.json`.

- **Admin console (recommended):** **Admin → Learning bytes → Upload MP4** next to the lesson. On Vercel the file goes straight from the browser to **Vercel Blob** (up to `MAX_VIDEO_MB`, default 500 MB). Students see it within a minute. You can Replace, Preview and Remove.
- **Folder:** put `pl.mp4`, `clear.mp4`… (named after the lesson ID) in `server/public/learning-bytes/`.
  - Locally they are picked up immediately.
  - On Vercel they are deployed with the next push.
  - GitHub refuses files over 100 MB, and big videos bloat the repository, so prefer the upload for production.
  - An upload wins over a folder file for the same lesson.

Encoding tip: **720p, H.264, AAC, "fast start"** (e.g. HandBrake "Fast 720p30"). Five minutes comes to about 30–60 MB. Keep each file under 512 MB, otherwise the Blob CDN does not cache it.

## Units: Watch → Play → Read

Each unit is one lesson with three steps in the bar at the top: **Watch** (MP4 video) → **Play** (interactive HTML game) → **Read** (HTML notes). The bottom bar has **← Previous** and **Next**.

- **Admin → Learning bytes**: one row per unit with three upload slots. Watch takes an `.mp4` (H.264). Play and Read each take one self-contained `.html` file. You can Preview, Replace or Remove each; removing brings back the built-in file.
- Uploaded HTML runs in a sandbox: it cannot see the student's session or call the site's API, and it cannot save data in the browser.
- Read shows "Reading material is coming soon" until something is uploaded.
- The built-in units and their default files are listed in `server/content/units.json` (`watch.file`, `play.file`, optional `read.file`). They are copied into the site by `npm run build`, so no cloud storage is needed. Unit ids must never change once students have progress.

## Student master data

Students register with their **NIAT ID** and **their own mobile number** (verified by OTP). An admin approves each registration in **Admin → Approvals**, which shows whether the number matches the sheet and flags two people claiming one NIAT ID. Afterwards students log in with their NIAT ID; codes go to their own number. The master list is the Excel sheet (first sheet) or a CSV with these columns:

| Column | Required | Notes |
|---|---|---|
| NIAT ID | yes | login ID, e.g. N26P02A0001 (case and spaces ignored) |
| Phone No. | no | optional; shown to admins to compare with the number the student registers |
| Student Name, Email IDs | no | shown to admins; name appears on the leaderboard |
| User id | no | LMS user id, stored for future LMS linking |
| University | no | also read as *University Name*, *College* or *Institute*. Fills the **University** tab of the leaderboard (a dropdown of every university in the sheet; ranks restart at #1 within each). A sheet without this column leaves each student's university unchanged. |

- **Admin → Master data →** upload the `.xlsx` → preview → *Replace* (students not in the file are deactivated) or *Merge*.
- **From your computer:** `npm run import-students -- "Alard Student Data __ Final count .xlsx"` (with the production DATABASE_URL in server/.env).
- **Local / self-hosted server:** save it as `server/data/students.xlsx`; it re-imports automatically when the file changes.

Spreadsheets and CSVs are excluded from git and Docker images (.gitignore / Dockerfile.dockerignore) so student data never leaves your machines.

## Run locally

```bash
cd server
npm install
npm run build              # portal + questions + lesson catalog + uploader bundle
npm run create-admin -- --email you@nxtwave.co.in --name "Your Name" --super
npm start                  # http://localhost:3000
```

Locally the database is **PGlite** (real Postgres in WebAssembly, stored in `data/pglite`), Redis is replaced by memory, and uploads go to `data/uploads`. Nothing else needs installing. OTP codes show on the login screen.

## Deploy to Vercel

**Plan:** Vercel **Pro** is required: commercial use, per-minute cron, and functions up to 800 s.

1. Push the repository to GitHub/GitLab. In Vercel, **Add New Project** and select the repository.
   - **Root Directory:** `Saturday Sprint/server`
   - Keep **"Include files outside the root directory in the Build Step"** enabled. The build reads `../saturday_sprint_portal*.html`. Alternatively, copy that HTML into `server/portal-source/`.
   - Framework preset: *Other* (`vercel.json` sets build, output, functions, rewrites and cron).
2. **Storage:** connect from the project's **Storage / Marketplace** tab:
   - **Neon Postgres.** Pick the region closest to India and match the function region in `vercel.json` (`bom1`, Mumbai). Use the **pooled** connection string for `DATABASE_URL`.
   - **Upstash Redis**, in the same region. This adds `KV_REST_API_URL` / `KV_REST_API_TOKEN`.
   - **Vercel Blob**, access **Public**. This adds `BLOB_READ_WRITE_TOKEN`.
3. **Environment variables:** `APP_SECRET`, `CRON_SECRET`, `OTP_PROVIDER` (+ its keys). See `.env.example`.
4. Deploy. Check `https://<your-domain>/api/health`; it should report `db: postgres, redis: true, blob: true`.
5. Create the first admin from your computer with the production `DATABASE_URL` in `server/.env`:
   `npm run create-admin -- --email you@nxtwave.co.in --super`
6. Import the master list (Admin → Master data), upload learning bytes, and set the Sprint window.

**Sizing for the Sprint day:**
- Set Neon autoscaling to at least **4–8 CU** for the event window.
- Optionally pre-warm by hitting `/api/health` a few minutes before 11:00.
- Ask students to log in the day before; sessions last 7 days. That keeps the OTP and SMS burst out of the 11:00 spike.

**Rough usage costs per Sprint (15k students), excluding the Pro subscription:**
- Upstash: ~2–3M commands ≈ $5.
- Functions: small, because grading is ~10–100 ms CPU per student.
- Blob video delivery is the main cost: ~$0.05/GB (US-East list price; regional prices differ). For example, 15k students × 20 videos × 40 MB ≈ 12 TB ≈ $600 if everyone watches everything.

Check current prices on vercel.com/pricing.

## Load test before the event

```bash
node loadtest/simulate.js make-csv 15000 > loadtest-students.csv
```

1. Import `loadtest-students.csv` into a **staging** deployment that has its own database. Set `ALLOW_TEST_OTP=true` there (it is refused on production) and open the Sprint window.
2. Run from several machines, ~3,000 students each, using `--offset` so each machine gets different students:
   ```bash
   node loadtest/simulate.js run --url https://staging.example.com --students 3000 --offset 0    --ramp 120
   node loadtest/simulate.js run --url https://staging.example.com --students 3000 --offset 3000 --ramp 120
   ```
3. Watch p95/p99 latency and errors in the output, and Neon / Upstash / Vercel Observability dashboards.

## How the pieces fit

```
config.js       settings (env / .env)          kv.js        Redis (Upstash) or in-memory: rate limits, caches, drafts
db.js           Postgres (Neon) or PGlite      auth.js      sessions, student OTP, admin password + TOTP
students.js     CSV import & validation        sprint.js    test window, attempts, autosave, grading, leaderboard
media.js        learning-byte videos           grader.js    worker-thread pool running Python (grader-worker.js)
otp.js          SMS providers                  index.js     Express routes;  api/index.js = Vercel entry
vercel.json     build, rewrites, cron, region  scripts/     build-portal, build-client, create-admin, import-students
public/         login, admin, portal (built), bridge, learning-bytes/      loadtest/   load simulator
```

## Tests

`npm test` runs the end-to-end suite on a throwaway PGlite database. It covers:
- registration and login, OTP lockout, one account per NIAT ID, Excel import, the cross-site block
- master-file import
- answers never reaching the browser, server grading (including an infinite loop), auto-submit
- leaderboard ranking
- admin TOTP, marking, disabling accounts
- video upload with seeking, and folder pickup
