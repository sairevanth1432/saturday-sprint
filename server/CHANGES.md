# Making changes after the site is live

Most day-to-day changes need **no deployment at all**: they are done in the admin console and take effect immediately. Only code and portal-content changes go through the deploy steps below.

## 1. What changes where

| You want to… | Where | Downtime |
|---|---|---|
| Add/update/remove students | **Admin → Master data**: upload the new Excel sheet (Replace or Merge) | none |
| Approve or reject student registrations | **Admin → Approvals** | none |
| Change a student's login phone (lost SIM, new number) | **Admin → Students** → student → *Change login phone* | none |
| Let a student register again from scratch | **Admin → Students** → student → *Reset registration* (super admin) | none |
| Add, replace or remove a lesson video | **Admin → Learning bytes** | none |
| Change Sprint date, time, duration; show/hide leaderboard | **Admin → Sprint settings** | none |
| Mark written answers, reset an attempt | **Admin → Results** | none |
| Add/remove admins, reset an admin's 2-step | **Admin → Admins** | none |
| Change SMS provider, keys, domain, secrets | `server/.env` on the server, then `docker compose up -d` | ~5–10 s |
| Add a new unit (byte video + game) | Add the files + an entry in `server/content/units.json` → [deploy](#3-deploying-a-code-or-content-change) | ~10 s |
| Change lessons, explainers or the Sprint questions (the portal HTML) | Save the new `saturday_sprint_portal (N).html` → [deploy](#3-deploying-a-code-or-content-change) | ~10 s |
| Change the app's code (login page, admin console, server) | Edit → test → commit → [deploy](#3-deploying-a-code-or-content-change) | ~10 s |

> **Rule:** never deploy during a Sprint window. The deploy script refuses to run from 30 minutes before opening to 30 minutes after closing.

## 2. The change workflow (for code and portal content)

```
your computer                       GitHub                         server
─────────────                       ──────                         ──────
1. edit files
2. npm test   (must pass)
3. npm start  (try it at localhost:3000)
4. git commit + git push  ───────►  main branch  ◄──────────  5. bash scripts/deploy.sh
                                                                  (backup → pull → build → health check → auto-rollback)
```

### Step by step

**On your computer** (in `Saturday Sprint/server`):

1. Get the latest code first, especially if more than one person works on it:
   ```bash
   git pull
   ```
2. Make the change.
   - **Portal content** (lessons, questions, text): put the new `saturday_sprint_portal (5).html` next to the old one in `Saturday Sprint/`. The newest file is used automatically. Then run:
     ```bash
     npm run build
     ```
     If the build stops with *"anchor not found"*, the portal layout changed in a place the integration hooks into; send that error to whoever maintains `scripts/build-portal.js`.
   - **Code:** edit the files.
3. Test:
   ```bash
   npm test
   npm start
   ```
   Open http://localhost:3000 and check what you changed.
   - Locally the database is a throwaway copy (`server/data/pglite`), so you cannot break production from here.
   - Login codes are shown on screen.
4. Save and publish the change:
   ```bash
   git add .
   git commit -m "Describe the change, e.g. Update lesson 3 questions"
   git push
   ```
   Pushing does **not** change the live site yet.

**On the server:**

5. Connect and deploy:
   ```bash
   ssh -i ssh-key.key ubuntu@<server-ip>
   cd ~/saturday-sprint/server
   bash scripts/deploy.sh
   ```
   The script then does the following, in order:
   - Refuses if a Sprint is open or about to open.
   - Backs up the database to `~/backups/`.
   - Pulls the new code and rebuilds the app. The database, Redis and HTTPS stay up.
   - Checks the site is healthy.
   - If the site is not healthy within about a minute, **automatically switches back to the previous version** and shows the error log.

### Marking versions you may want to return to
Before a big change, or after a version that worked well on a Sprint day:
```bash
git tag sprint-2026-10-03 && git push --tags
```

## 3. Deploying a code or content change

Summary of the commands:

| Where | Command |
|---|---|
| Your computer | `npm test` → `git commit` → `git push` |
| Server | `cd ~/saturday-sprint/server && bash scripts/deploy.sh` |

## 4. Rolling back

| Situation | Do this on the server |
|---|---|
| The new version is broken | `bash scripts/deploy.sh <previous-tag-or-commit>` (find it with `git log --oneline -10`) |
| The deploy script already rolled back | Nothing to do; fix the change on your computer and deploy again |
| Data was damaged (e.g. a wrong master list was uploaded) | Upload the correct Excel sheet again (Replace). Accounts, attempts and results are never deleted by an import. |
| You need to restore the whole database | See below |

**Restore a database backup** (stops the site for a minute; last resort):
```bash
cd ~/saturday-sprint/server
docker compose stop app
docker compose exec -T db psql -U sprint -d postgres -c "DROP DATABASE sprint WITH (FORCE)" -c "CREATE DATABASE sprint OWNER sprint"
gunzip -c ~/backups/before-deploy-2026-10-05-1012.sql.gz | docker compose exec -T db psql -U sprint sprint
docker compose start app
```

## 5. Changing settings in `.env`

```bash
cd ~/saturday-sprint/server
nano .env
docker compose up -d
```
Only containers whose settings changed are restarted. `.env` is never in git, so keep a copy of it somewhere safe (a password manager).

## 6. Database changes

You don't run database migrations by hand. When the app starts, it creates any new tables and columns it needs (`db.js`). New code must only **add** tables or columns, never remove or rename existing ones, so older backups and rollbacks keep working.

## 7. Rules that keep production safe

- **No deploys during a Sprint**, and preferably none in the 24 hours before one. Use the admin console for any last-minute content.
- Every change goes through `npm test` before `git push`.
- Deploy with `scripts/deploy.sh`, never with ad-hoc commands; it backs up first and can roll back.
- Only people who need it get server SSH access and GitHub write access. Admins who only manage content need **admin console** access only.
- Copy `~/backups` off the server regularly (nightly backup is in DEPLOY.md, step 11).

## 8. If you host on Vercel instead

- `git push` to `main` deploys automatically.
- Pushing any other branch creates a **preview URL**, where you can test before merging.
- Rollback: Vercel dashboard → *Deployments* → pick the previous one → **Instant Rollback**.
- Settings live in *Project → Settings → Environment Variables*. Changing them needs a redeploy.
- The same no-deploys-during-a-Sprint rule applies; Vercel does not enforce it for you.
