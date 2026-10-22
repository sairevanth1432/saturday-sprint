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
| Byte, the mascot (the round yellow robot; its outfit changes with the pose, short sleeves only so it suits any weather: tees, sports tee and sneakers, polo, pyjamas and night cap, side-turned cap, fedora, bucket hat, graduation cap, party hat; glasses, shades when hyped): on Home with a speech bubble (tap for the day's quote and tips); it keeps busy when nothing is going on (codes, sips water, reads, thinks, vibes, stretches, a new thing every 8 s); on every other tab at the bottom of the left panel, with a short bubble above it (beside it when the panel is collapsed) when something happens (answer right/wrong, water break every 45 min, stretch every 90 min, late night, first visit to Practice/Learn, music on). The daily quote is said by Byte (opening Practice shows it); it is no longer printed in the Practice top bar. The bubble never takes clicks. 19 poses; never shown during the test. Preview any pose with `?byte=dance` (or run, trophy, tired…) | Drawing, poses and styles: `BYTE_*` in `server/scripts/build-portal.js` (each part lists the poses it shows in). Which pose and line when: `ssByteVals` / `ssByteEvent` in `server/public/portal-bridge.js` → [deploy](#3-deploying-a-code-or-content-change) | ~10 s |
| Learn: a 4th step "Practice" after Watch / Play / Read shows that topic's questions inside Learn (same questions, answers and scores as the Practice page; coding problems open in the editor). Play and Read have no full screen of their own; the top bar's Full screen button puts the whole portal in full screen. The portal switches to full screen on the student's first click or key press after opening it (browsers allow it only after one; not on phones or during the test; after Esc it stays off until the next visit). Practice from the sidebar opens in full screen with a thin left rail: pointing at the rail opens the full panel over the page (topics, Practice, Sprint test); picking a topic switches Practice to it | Practice step: `LEARN_PRACTICE` in `server/scripts/build-portal.js`, `ss_lp` / `ssPracticeMatch` in `server/public/portal-bridge.js`. Rail on hover: `ssPeek` (bridge) and the `html.ss-peek` styles (build-portal.js) → [deploy](#3-deploying-a-code-or-content-change) | ~10 s |
| Profile page (photo, streak, medals and how to earn them), sound cues, daily practice quote | Data: `server/journey.js` (GET /api/journey). Markup: `PROFILE_TAB` and the sidebar user button in `server/scripts/build-portal.js`. Logic and cues: `ssProfileVals`, `ssCue` in `server/public/portal-bridge.js`. Quotes: the `Q` list in the portal HTML → [deploy](#3-deploying-a-code-or-content-change) | ~10 s |
| Portal layout: sidebar = Topics list + Practice + Focus mode; top-right icon bar (Sprint test, Leaderboard, sound, music, profile menu, menu); Home topic map | Sidebar: the `<nav>` in the portal HTML. Top bar, map, profile: `TOPBAR`, `HOME_MAP`, `PROFILE_TAB` in `server/scripts/build-portal.js`. Logic: `ssFocus`, `ssMapVals`, `ssTopicItems` in `server/public/portal-bridge.js` → [deploy](#3-deploying-a-code-or-content-change) | ~10 s |
| Background music (lo-fi chiptune loop, off until the student turns it on) | `server/public/music/lofi-loop.wav`, made by `node scripts/make-music.js` (edit tempo, chords, voices there) → [deploy](#3-deploying-a-code-or-content-change) | ~10 s |
| Interview questions from the Hiring Intelligence export into Practice | `Desktop/Saturday Sprint/hiring-questions/portal-import/<course>/<topic>.json` → **Admin → Practice questions → Import JSON** (they arrive as drafts: add the options, then publish) | none |

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
