# saturday-sprint

Saturday Sprint student portal for NIAT: NIAT ID + OTP login with admin approval, learning units
(Watch → Play → Read), a server-graded End-of-Sprint Test, a leaderboard and an admin console.

| Folder / file | What it is |
|---|---|
| `server/` | The application (Node + Express). Start here: [server/README.md](server/README.md) |
| `server/VERCEL.md` | Deploying on Vercel from this repository |
| `server/DEPLOY.md`, `server/HOSTING.md` | Self-hosting with Docker (e.g. a free Oracle Cloud VM) |
| `server/CHANGES.md` | Making changes once it is live |
| `server/TESTING.md` | Test accounts and the testing checklist |
| `saturday_sprint_portal (4).html` | The portal design. `npm run build` in `server/` turns it into the live portal |
| `NIAT-topic-pack/` | Unit videos (MP4) and games (HTML) |

Student data (Excel/CSV sheets) is never committed; see `.gitignore`.
