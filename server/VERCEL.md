# Deploying on Vercel (Pro) from GitHub

After this setup, every `git push` to `main` updates the live site automatically.

## 1. GitHub
1. On github.com: **New repository** → name `saturday-sprint` → **Private** → leave *all* boxes unticked (no README, no .gitignore) → **Create repository**.
2. Push this folder (the repository already exists locally, with the first commit):
   ```bash
   cd "C:\Sprint web - NIAT\Saturday Sprint"
   git remote add origin https://github.com/<your-username>/saturday-sprint.git
   git push -u origin main
   ```
   A browser window asks you to sign in to GitHub the first time.

## 2. Create the Vercel project
1. vercel.com → **Add New… → Project** → **Import** the `saturday-sprint` repository. Allow Vercel to see it if asked.
2. On the import screen:
   - **Root Directory:** click *Edit* → choose **`server`**.
   - **Framework Preset:** *Other*. `vercel.json` sets the build, the output and the cron.
   - **Environment Variables:** add these now:

     | Name | Value |
     |---|---|
     | `APP_SECRET` | 64 random characters, e.g. from `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
     | `CRON_SECRET` | another random value (same command) |
     | `PRELAUNCH_TEST_MODE` | `true` (login codes shown on screen until SMS is set up; see step 6) |
3. Click **Deploy**. **This first deployment will fail** with *"DATABASE_URL is not set"*. That is expected: the database is added next.

## 3. Storage (project → **Storage** tab)
Use the **same region** for all three, as close to India as offered: Mumbai, or else Singapore.
1. **Create Database → Neon** (Postgres) → choose the region → connect it to **Production and Preview**. This adds `DATABASE_URL`.
2. **Create → Upstash** (Redis) → same region → connect to the project. This adds `KV_REST_API_URL` / `KV_REST_API_TOKEN`.
3. **Create → Blob** → access **Public** → connect to the project. This adds `BLOB_READ_WRITE_TOKEN`, used for uploaded videos.

Then **Deployments → ⋯ on the failed one → Redeploy**.

**Function region:** `vercel.json` has `"regions": ["bom1"]` (Mumbai). If you chose Singapore for Neon, change it to `["sin1"]` and push. The functions should sit next to the database.

## 4. Check it
- Open `https://<your-project>.vercel.app/api/health`. It should show `"db":"postgres"`, `"redis":"upstash"`, `"storage":"blob"`.
- Open `https://<your-project>.vercel.app/login`. It should load the login page.

## 5. First admin and data
Create the first admin from your computer, pointed at the production database (Neon dashboard → *Connection string*, **pooled**):
```powershell
cd "C:\Sprint web - NIAT\Saturday Sprint\server"
$env:DATABASE_URL = "postgres://...-pooler.../neondb?sslmode=require"
npm run create-admin -- --email you@nxtwave.co.in --name "Your Name" --super
Remove-Item Env:DATABASE_URL
```
Then on the live site:
1. Go to `/admin` → log in with the temporary password → set up the authenticator app → choose your own password.
2. **Master data** → upload the Excel sheet → **Replace**.
3. **Learning bytes** → check Watch / Play / Read for each unit.
4. **Sprint settings** → set the date, time and 20 minutes.

**Test students:** `TEST0001`… can be added with `node scripts/test-accounts.js add --phones 9000000001,9000000002`, with the same `$env:DATABASE_URL` set. In test mode the code appears on screen, so any number works.

## 6. Before students use it (launch checklist)
- [ ] Set up SMS: `OTP_PROVIDER` = `msg91` (+ `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID`) or `webhook` (+ `OTP_WEBHOOK_URL`, `OTP_WEBHOOK_TOKEN`).
- [ ] **Delete `PRELAUNCH_TEST_MODE`** in Project → Settings → Environment Variables → Redeploy.
- [ ] `node scripts/test-accounts.js remove` (with `$env:DATABASE_URL` set).
- [ ] Optional: a custom domain in Project → Settings → Domains.
- [ ] Upgrade Upstash from the free plan before the Sprint. One Sprint uses millions of commands.

## Updating later
Edit → `npm test` → `git commit` → `git push`. Vercel builds and deploys `main` automatically. Other branches get their own preview URL. To undo a bad deploy: Deployments → pick the previous one → **Instant Rollback**.
