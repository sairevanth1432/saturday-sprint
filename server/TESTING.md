# Testing guide: accounts, compatibility checklist, local and production

## 1. Test accounts

### Local (http://localhost:3000)
Create or reset them any time with `npm run seed-test` (local database only; it refuses to touch production).

| Use | Login | Password / code |
|---|---|---|
| Super admin, http://localhost:3000/admin | `admin@test.local` | `SprintAdmin#2026` |
| Admin with fewer rights (no imports, settings or admin management) | `staff@test.local` | `SprintStaff#2026` |
| Student, already approved | `TEST0001`, `TEST0002`, `TEST0003` | password `Sprint2026` (or *Log in with a code*: code shown on screen) |
| Student, waiting for approval | `TEST0004` | approve in Admin → Approvals |
| Student, not registered yet | `TEST0005` + any 10-digit mobile number + a password you choose | code shown on screen |
| One student per university (approved) | `TEST-<NIAT ID prefix>` with name `Test <first word of the university>`: `TEST-N26P02A` / `Test ALARD`, `TEST-N26AP01A` / `Test GMR`, `TEST-N26H02A` / `Test Malla`… (all 27 are printed by the seed) | name login, or password `Sprint2026` |

- University test students carry their university, so each sees **its own university's leaderboard**. A full student-sheet import never deactivates them (batch `TEST`).

- The seed also opens a separate test Sprint called `local-test` for 24 hours, so you can take the test. `npm run seed-test -- --no-sprint` leaves the Sprint settings alone.
- Locally, `server/.env` turns off the authenticator step for admins. To test it, set `ADMIN_REQUIRE_TOTP=true` and restart.

### Production (your live domain)
Real SMS is sent there, so test students need phones your testers hold:
```bash
docker compose exec app node scripts/test-accounts.js add --phones 98XXXXXXXX,97XXXXXXXX --password Sprint2026
docker compose exec app node scripts/test-accounts.js universities   # TEST-N26P02A / Test ALARD … one per university, no phone needed
docker compose exec app node scripts/test-accounts.js list
docker compose exec app node scripts/test-accounts.js remove      # before the real Sprint
```
- This creates approved students `TEST0001`, `TEST0002`… (batch `TEST`). They never appear on the production leaderboard.
- **Admins** on production: `docker compose exec app node scripts/create-admin.js --email you@yourdomain.com --super`. The authenticator app is required there.
- **Taking the test on production without opening the real Sprint:** log in as an admin and open the student portal (*Open student portal* in the admin sidebar). Admin preview opens the test any time and is never ranked.

## 2. Devices and browsers to cover

| Device | Browsers | Screen |
|---|---|---|
| Windows laptop/desktop | Chrome, Edge, Firefox | 1366×768 and 1920×1080 |
| Mac | Safari, Chrome | 1440×900 |
| Android phone | Chrome | ~390–412 px wide |
| iPhone | Safari | ~390 px wide |
| Tablet (optional) | Chrome / Safari | 768–1024 px wide |

> **Known limitation, check on phones first.** The student portal comes from the original Saturday Sprint design, which is laid out for laptop/desktop screens (at least 1180 px wide). On a phone it opens as a wide page you scroll sideways and zoom. The **login page and admin console are mobile-friendly**. If many students will use phones, the portal design needs a mobile layout.

**Testing on a phone with the local server** (same Wi-Fi as your laptop):
1. In `server/.env`, set `HOST=0.0.0.0` and restart `npm start`. Allow Node through the Windows firewall if asked.
2. Find your laptop's IP (`ipconfig` → IPv4, e.g. 192.168.1.20) and open `http://192.168.1.20:3000` on the phone.
3. **Set `HOST=127.0.0.1` again afterwards.** Your local database holds the real student list, and login codes are shown on screen locally.

**Simulating slow networks** without a phone: Chrome → F12 → *Network* → throttling **Slow 4G / 3G**. Use *Offline* for the autosave tests.

## 3. Checklist

Mark each ✅ / ❌ per browser. *Expected* is what should happen.

### A0. Simple log-in (initial roll-out: Admin → Sprint settings → Student log-in = Simple, the default)
| # | Steps | Expected |
|---|---|---|
| S1 | Log in as `TEST0002` with name `Test Student Two` | Portal opens; no registration, code or password |
| S2 | Same ID with `test two student` / `TEST STUDENT TWO` | Works: case, dots and word order do not matter |
| S3 | Same ID with only `Test` | "That NIAT ID and name do not match the student list…" |
| S4 | Admin → Student analytics → `TEST0002` | The login is listed with time, device and network address |
| S5 | Switch Student log-in to Secure → reload /login | Log in / Register tabs with password and phone code (section A) |

### A. Student login and registration (Secure mode)
| # | Steps | Expected |
|---|---|---|
| A1 | Open `/` while logged out | Redirected to the login page |
| A2 | Log in with `N26P02A9999` (not in the list) | "This NIAT ID is not in the student list…" |
| A3 | Register `TEST0005` + a 10-digit number + a password (twice) → enter the code | "Waiting for approval" screen |
| A4 | Log in as `TEST0005` before approval | "Waiting for approval" |
| A5 | Admin → Approvals → approve `TEST0005` → log in with NIAT ID + password | Portal opens, no code needed |
| A5b | Wrong password | "Wrong NIAT ID or password." with a *Forgot password?* link; 8 wrong tries lock the account for 15 min |
| A5c | *Forgot password?* → code → choose a new password | Portal opens; the old password stops working; other devices are signed out |
| A5d | Admin → Students → `TEST0002` → *Reset password* → student logs in with a code | Asked to set a new password |
| A6 | Enter a wrong code 5 times | "Too many wrong codes. Request a new one." |
| A7 | Press *Resend* straight away | Countdown; resend only after it ends |
| A8 | Register a second NIAT ID with a phone already used by `TEST0001` | "This phone number is already linked…" |
| A9 | Log out (sidebar) | Back on the login page; `/` redirects to login |

### B. Learning
| # | Steps | Expected |
|---|---|---|
| B1 | Learn → each course → *Show topics* | Original units plus the 6 new units (3 per course) |
| B2 | Open a unit → step bar shows **1 Watch → 2 Play → 3 Read** | Upright video with controls; plays with sound and can be seeked |
| B3 | *Next: Play →* then *Next: Read →* | Game fills the frame; Read shows the notes or "coming soon"; ✓ on finished steps |
| B3b | *← Watch* / *← Play*, and *← Previous* on a unit's first step | Goes back a step, or to the previous unit's Read step |
| B4 | Original lessons: Watch / Read / Try | Explainer animation, narration, readings and try-it work as before |
| B5 | Practice → MCQs and coding problems; *Run* Python | Output shows; hidden tests give ✓/✗ |
| B6 | Finish some lessons → log out → log in on another browser | Lesson progress is still there |

### C. End-of-Sprint test (use the `local-test` Sprint, or admin preview)
| # | Steps | Expected |
|---|---|---|
| C1 | Sprint test → Start | Timer starts, questions appear |
| C2 | Answer a few → **refresh the page** | Same question set, answers still there, timer continues |
| C3 | DevTools *Offline* → answer → back *Online* | "Offline…" notice, then saving resumes |
| C4 | Coding question → *Check (hidden tests)* | ✓/✗ per hidden test, no expected outputs revealed |
| C5 | Submit | Feedback form first, then score, rank and leaderboard |
| C6 | Start again as the same student | "You have already submitted this Sprint." |
| C7 | Let a test run out of time (Admin → Sprint settings → set close time 2 min ahead) | Auto-submitted within ~20 s of the end |
| C8 | Start → rules screen → *Start the test* | Browser goes full screen; NIAT ID watermark over the questions |
| C9 | During the test: select text, Ctrl+C, right-click, Ctrl+P | Nothing is copied or printed; logged in the attempt timeline |
| C10 | Switch tab (Ctrl+Tab) / Alt+Tab to another app / press Esc to leave full screen | "Warning 1 of 3" over the questions; *Continue* returns to full screen |
| C11 | Third violation | Submitted automatically; result says "too many proctoring violations" |
| C12 | Open the running test in a second tab | Second tab is blocked; counted as a violation |
| C13 | Click *Learn* or *Practice* while the test runs | "Finish and submit the Sprint first" |
| C14 | Admin → Results → *Proctoring flags* → open the attempt | Violation counts and a timeline of every event |

### C2. Sprint questions and the answers review
| # | Steps | Expected |
|---|---|---|
| Q1 | Admin → Sprint questions (current Sprint) | The built-in 18 questions, read-only, "uses the built-in questions" |
| Q2 | Sprint settings → set a new Sprint ID → Sprint questions → *Copy questions…* → built-in | 18 questions copied; Edit, Delete, ↑ ↓ appear |
| Q3 | *Add question*: course, unit, text, code, 4–6 options, tick the correct one | Appears at the end; the test shows it with letters A–F |
| Q4 | A student starts the test → try to edit a question | "…students have already started this Sprint…" (locked) |
| Q5 | Sprint settings → *Students see the answers review* = After the Sprint closes → submit as a student | Result card: "review opens when the Sprint closes"; /review says the same |
| Q6 | Set it to *Right after each student submits* → open /review | Every question with your answer (red if wrong) and the correct one (green), score per unit, "revise this" under 60% |
| Q7 | Set it to *Hidden* | No review button; /review says it is not available |
| Q8 | Super admin → Sprint questions → pick a Sprint that is not live → *Test this Sprint ↗* | Portal opens with "Admin preview of Sprint …"; the test starts even outside the window; students still see the live Sprint |
| Q9 | Submit the preview → *Take the test again* | A fresh attempt with the same questions; previews are never ranked |

### D. Leaderboard
| # | Steps | Expected |
|---|---|---|
| D1 | Submit as `TEST0001`, `TEST0002`, `TEST0003` with different scores | Ranked by score, then time; "you" row highlighted |
| D2 | Home page | Leaderboard card with the top 5 and your rank |
| D3 | Admin → Sprint settings → hide leaderboard | Students see "hidden"; admins still see it |

### E. Admin console (log in as `admin@test.local`, then repeat key items as `staff@test.local`)
| # | Steps | Expected |
|---|---|---|
| E1 | Overview | Counts, infrastructure row, warnings |
| E2 | Approvals: approve, reject with reason, *Approve all that match the sheet* | Lists and badge update; rejected student sees the reason |
| E3 | Students: search, filter, open a student, edit, disable/enable, *Change login phone* | Saved; a disabled student is logged out |
| E4 | Results: open an attempt, mark written answers | Total and rank update |
| E5 | Exports (results / students / feedback CSV) | Files open in Excel |
| E6 | Master data: upload the Excel sheet → preview → Merge | Preview counts match; nothing changes until you confirm |
| E7 | Learning bytes: upload an MP4 (Watch) and an .html (Play, Read) for a unit → Preview → Remove | Students see the new content after reloading; after Remove the built-in file returns |
| E8 | As `staff@test.local`: try Master data import, Settings save, Admins | Blocked ("Super admin only") / read-only |
| E9 | Audit log | Every action above is listed with who and when |

### F. Security spot checks
| # | Steps | Expected |
|---|---|---|
| F1 | As a student, open `/api/admin/overview` in the address bar | `{"error":"AUTH"…}` |
| F2 | View page source of the portal; search for a test answer | Answers are not in the page |
| F3 | Wrong admin password 5 times | Account locked for 15 minutes |

### G. Production only (after deployment)
| # | Check | Expected |
|---|---|---|
| G1 | `https://<domain>/api/health` | `ok: true`, `db: postgres`, `redis: redis`, `storage` as configured |
| G2 | Padlock in the browser | Valid HTTPS certificate |
| G3 | Register/log in with a test student | SMS arrives within ~10 s with the approved (DLT) template text |
| G4 | Video from R2 / the server | Plays and seeks on phone data (not only Wi-Fi) |
| G5 | Sprint settings show the right **IST** open/close time | Matches the timetable |
| G6 | Load test (DEPLOY.md, step 10) | No errors at the expected number of students |
| G7 | **Before the real Sprint:** `test-accounts.js remove` and auto-approve off | `list` shows no test students |

## 4. Automated tests
`npm test` runs 18 end-to-end checks covering login, approvals, grading, leaderboard, admin, imports and videos. It uses a throwaway database. Run it before every deployment.

## 5. Reporting a problem
Note the following for each bug:
- the checklist number (e.g. B3)
- browser and device
- what you did and what you saw (a screenshot helps)
- the time it happened

For server errors, also send the output of `docker compose logs --since 10m app`.
