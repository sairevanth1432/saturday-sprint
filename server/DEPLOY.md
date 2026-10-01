# Deployment guide (free setup: Oracle Cloud + Cloudflare)

This guide sets up:

```
students ─► https://sprint.yourdomain.com ─► Oracle Cloud free VM (Docker: Caddy → app → Postgres + Redis)
students ─► https://videos.yourdomain.com ─► Cloudflare R2 (learning-byte videos, free bandwidth)
```

**Time needed:** about 2–3 hours the first time. Do it at least a week before the Sprint, so the load test and SMS approval have time.

---

## 0. Before you start: what you need

| Item | Why | Cost |
|---|---|---|
| A **domain name** (e.g. `niatsprint.in`) | HTTPS and the video address | ~₹800/year (only paid item) |
| **GitHub** account | stores the code | free |
| **Cloudflare** account | DNS + video storage (R2) | free (R2 asks for a card, charges nothing within the free tier) |
| **Oracle Cloud** account | the server | free (asks for a card for verification) |
| **SMS provider** (MSG91, or your LMS's SMS service via webhook) | OTP codes to students | per-SMS. DLT registration in India takes days, so **start now** |
| A computer with **Git** and **SSH** | to push code and reach the server | — |

> Keep a notes file open. You will collect passwords and keys as you go; the guide says **📝 note** each time.

---

## 1. Put the code on GitHub (your computer)

1. On github.com: **New repository** → name `saturday-sprint` → **Private** → do **not** add a README → **Create**.
2. Open a terminal **in the "Saturday Sprint" folder** (the one containing `saturday_sprint_portal (4).html` and `server/`):
   ```bash
   git init
   git add .
   git commit -m "Saturday Sprint portal"
   git branch -M main
   git remote add origin https://github.com/<your-username>/saturday-sprint.git
   git push -u origin main
   ```
   Windows opens a browser window to sign in to GitHub the first time.
3. **Check on github.com that these are NOT in the repository:**
   - `server/data/` (only `students.example.csv` should be there)
   - `server/.env`
   - `node_modules`

   They are excluded by `.gitignore`. Student phone numbers must never go to GitHub.

✅ Checkpoint: the repository shows `saturday_sprint_portal (4).html` and the `server/` folder.

---

## 2. Cloudflare: domain and video storage

### 2a. Put your domain on Cloudflare
1. dash.cloudflare.com → **Add a domain** → enter your domain → **Free** plan.
2. Cloudflare shows **two nameservers**. Go to where you bought the domain and replace its nameservers with those two.
3. Wait until Cloudflare says the domain is **Active** (minutes to a few hours).

### 2b. Create the video bucket (R2)
1. Cloudflare dashboard → **R2 Object Storage** → **Create bucket** → name `learning-bytes` → location *Asia-Pacific* (or Automatic) → **Create**.
2. Open the bucket → **Settings** → **Custom Domains** → **Connect Domain** → `videos.yourdomain.com` → confirm.
   - 📝 note: `S3_PUBLIC_URL = https://videos.yourdomain.com`
3. Same **Settings** page → **CORS policy** → **Add CORS policy** → paste:
   ```json
   [
     {
       "AllowedOrigins": ["https://sprint.yourdomain.com"],
       "AllowedMethods": ["PUT", "GET"],
       "AllowedHeaders": ["content-type"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
4. Back on **R2 Object Storage** overview → **Manage API tokens** (or *API* → *Manage R2 API Tokens*) → **Create API token**:
   - Permissions: **Object Read & Write**
   - Specify bucket: `learning-bytes`
   - **Create**. Cloudflare shows these values **only once**:
   - 📝 note: `S3_ACCESS_KEY_ID`
   - 📝 note: `S3_SECRET_ACCESS_KEY`
   - 📝 note: the S3 endpoint `https://<account-id>.r2.cloudflarestorage.com` → `S3_ENDPOINT`

✅ Checkpoint: the bucket exists, has a custom domain, a CORS policy, and you have 4 notes.

---

## 3. Oracle Cloud: create the free server

1. Sign up at oracle.com/cloud/free.
   - **Home region:** pick **India South (Hyderabad)** or **India West (Mumbai)**. It cannot be changed later, and free servers live only in the home region.
2. Console → **Compute → Instances → Create instance**:
   - **Name:** `sprint`
   - **Image:** *Canonical Ubuntu 24.04*
   - **Shape:** *Change shape* → **Ampere** → **VM.Standard.A1.Flex** → **2 OCPU, 12 GB memory**. It must show the *Always Free-eligible* label.
   - **Networking:** keep the defaults (new VCN, public subnet, **Assign public IPv4**: yes)
   - **SSH keys:** *Generate a key pair* → **download the private key** (📝 keep it safe)
   - **Create**
   - If you get *"Out of capacity"*, try another availability domain, or retry later; free Arm capacity fluctuates.
3. When it is **Running**: 📝 note the **Public IP address**.
4. Open web ports: instance → **Subnet** link → **Security List** (Default) → **Add Ingress Rules**:
   - Source CIDR `0.0.0.0/0`, TCP, destination port **80**
   - Same again for port **443**

✅ Checkpoint: the instance is Running and has a public IP; the security list allows 80 and 443.

---

## 4. Point your domain at the server

Cloudflare dashboard → your domain → **DNS** → **Add record**:
- Type **A**, Name `sprint`, IPv4 = the Oracle public IP
- **Proxy status: DNS only (grey cloud)** for now. You can turn the proxy on later (step 11).

---

## 5. Prepare the server

1. Connect from your computer. Mac/Linux:
   ```bash
   chmod 600 ssh-key.key
   ssh -i ssh-key.key ubuntu@<PUBLIC-IP>
   ```
   On Windows, use PowerShell with the same `ssh` command.
2. On the server, open the web ports in the server's own firewall, and install Docker:
   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker ubuntu
   exit
   ```
3. Connect again (so the Docker permission applies) and check:
   ```bash
   docker run --rm hello-world
   ```

---

## 6. Get the code onto the server

The repository is private, so the server needs read access:
1. github.com → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Set:
   - **Repository access:** only `saturday-sprint`
   - **Permissions:** *Contents: Read-only*
   - **Expiration:** 1 year
3. 📝 note the token.
4. On the server:
   ```bash
   git clone https://github.com/<your-username>/saturday-sprint.git
   ```
   When asked, enter your GitHub username, and use the **token** as the password.

---

## 7. Configure

```bash
cd ~/saturday-sprint/server
cp .env.example .env
openssl rand -hex 32     # 📝 use as APP_SECRET
openssl rand -hex 24     # 📝 use as POSTGRES_PASSWORD
nano .env
```

Put these lines **at the top** of `.env`. Remove the `#` where a setting already exists commented out further down.

```ini
NODE_ENV=production
DOMAIN=sprint.yourdomain.com
APP_SECRET=<the first random value>
POSTGRES_PASSWORD=<the second random value>
WEB_CONCURRENCY=2
TRUST_PROXY=1

S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_BUCKET=learning-bytes
S3_ACCESS_KEY_ID=<from step 2b>
S3_SECRET_ACCESS_KEY=<from step 2b>
S3_PUBLIC_URL=https://videos.yourdomain.com

# OTP: choose ONE provider (see the comments in .env.example)
OTP_PROVIDER=msg91
MSG91_AUTH_KEY=<from MSG91>
MSG91_TEMPLATE_ID=<your DLT-approved template with ##OTP##>
```

To use your LMS's SMS service instead, set `OTP_PROVIDER=webhook`, `OTP_WEBHOOK_URL` and `OTP_WEBHOOK_TOKEN`. It receives `{phone, code, message}` as JSON.

> **No SMS provider yet?** For a trial run only, add `ALLOW_TEST_OTP=true`: the code is then shown on the login screen. **Remove it before real students use the site.**

Save with **Ctrl+O, Enter, Ctrl+X**.

---

## 8. Start

```bash
docker compose up -d --build
```
The first build takes 5–10 minutes. Then check:
```bash
docker compose ps
curl -s https://sprint.yourdomain.com/api/health
```
- `docker compose ps`: all four services should be `running` / `healthy`.
- The health check should return `{"ok":true,"db":"postgres","redis":"redis","storage":"s3",...}`.

If the HTTPS check fails, wait 1–2 minutes (Caddy is getting the certificate) and look at `docker compose logs caddy`.

---

## 9. First admin and content

1. Create the super admin:
   ```bash
   docker compose exec app node scripts/create-admin.js --email you@yourdomain.com --name "Your Name" --super
   ```
   📝 note the temporary password it prints.
2. Open **https://sprint.yourdomain.com/admin**:
   - Log in with the temporary password.
   - Scan the QR code with Google/Microsoft Authenticator and enter the code.
   - Set your own password.
3. **Master data** → upload the student Excel sheet (`.xlsx` with columns *User id, NIAT ID, Student Name, Email IDs, Phone No.*, e.g. *Alard Student Data __ Final count.xlsx*) → check the preview → **Replace master list**.
4. **Learning bytes** → **Upload MP4** next to each lesson → **Preview** to check it plays.
5. **Sprint settings** → set the open/close time, duration and Sprint ID.
6. **Admins** → add your colleagues. Each gets a temporary password, shown once.
7. **Test as a student**, the way students will do it:
   1. On your phone, open **https://sprint.yourdomain.com/login** → **Register**.
   2. Enter a NIAT ID from the sheet and **your own mobile number** → enter the SMS code. The page says *waiting for approval*.
   3. In **Admin → Approvals**, the request shows the name from the sheet and the number entered → **Approve**.
   4. Back on the phone: **Log in** with the NIAT ID → enter the SMS code → the portal opens.
8. **Tell students how to register:** "Go to sprint.yourdomain.com → Register → your NIAT ID + your own mobile number → enter the code → wait for approval → log in." Check **Admin → Approvals** daily, and more often in the days before the Sprint. For requests whose number matches the sheet, use **Approve all … that match the sheet**.

✅ Checkpoint: you received an OTP by SMS, your registration showed up in Approvals, after approval the portal opens, and a learning-byte video plays.

---

## 10. Load test (do not skip)

Do this on the real server **before** loading real students, or on a copy.

1. In `.env`, add `ALLOW_TEST_OTP=true`, then apply it:
   ```bash
   docker compose up -d
   ```
2. On your computer, in `Saturday Sprint/server`, make 15,000 test students:
   ```bash
   npm install
   node loadtest/simulate.js make-csv 15000 > loadtest-students.csv
   ```
3. Admin → Master data → upload `loadtest-students.csv` → **Merge**.
4. Admin → Sprint settings → open the window **now**, for 60 minutes, and tick **Auto-approve registrations** (load test only).
5. Run the simulator from **3–5 computers at the same time**, each with a different `--offset`:
   ```bash
   node loadtest/simulate.js run --url https://sprint.yourdomain.com --students 3000 --offset 0     --ramp 120
   node loadtest/simulate.js run --url https://sprint.yourdomain.com --students 3000 --offset 3000  --ramp 120
   node loadtest/simulate.js run --url https://sprint.yourdomain.com --students 3000 --offset 6000  --ramp 120
   # …offset 9000, 12000
   ```
   Meanwhile, on the server, run `docker stats`. Watch CPU and memory.
6. **Good result:** `errors: none` and p95 under ~1 s on every endpoint.
   - If CPU sits at 100 % with errors, the free VM is too small for 15k. Use the same steps on a bigger paid VM for the event (raise `WEB_CONCURRENCY` to its core count). No code changes are needed.
7. **Clean up:** this deletes **all** data, including admins:
   ```bash
   docker compose down -v
   ```
   Then remove `ALLOW_TEST_OTP` from `.env`, run `docker compose up -d`, and repeat step 9 (admin, master data, videos, settings).

---

## 11. Optional hardening

**Cloudflare proxy:** DNS → set `sprint` to **Proxied (orange cloud)**. Then:
- SSL/TLS → **Full (strict)**
- In `.env`, set `TRUST_PROXY=2`, then run `docker compose up -d`

**Nightly backups:** run `crontab -e` and add:
```
0 2 * * * cd ~/saturday-sprint/server && docker compose exec -T db pg_dump -U sprint sprint | gzip > ~/backup-$(date +\%F).sql.gz
```
Copy backups off the server regularly.

---

## 12. Sprint day checklist

- [ ] Students registered **in the days before**. Admin → Overview shows registrations; chase the rest.
- [ ] Sprint settings: correct open/close time.
- [ ] `ALLOW_TEST_OTP` is **not** in `.env`.
- [ ] At 10:45, run `curl https://sprint.yourdomain.com/api/health` → ok.
- [ ] Keep an SSH window open with `docker stats`. In a second window, run `docker compose logs -f app`.
- [ ] After closing: Results → mark the written answers. The leaderboard updates as you mark.
- [ ] Export results: Admin → Results → **Export CSV**.

---

## Updating the site later

See **[CHANGES.md](CHANGES.md)**. In short:
- **Students, approvals, videos, Sprint dates, marks:** use the admin console; no deployment needed.
- **Portal content or code:** on your computer, `npm test` → `git commit` → `git push`. Then on the server:
  ```bash
  cd ~/saturday-sprint/server && bash scripts/deploy.sh
  ```
  It backs up first, refuses during a Sprint, and rolls back by itself if the new version is unhealthy.

## If something goes wrong

| Symptom | Check |
|---|---|
| Site does not open | `docker compose ps`; `docker compose logs caddy` (DNS must point to the VM; ports 80/443 open in **both** the Oracle security list and iptables) |
| No OTP SMS | `docker compose logs app \| grep otp` (provider error text is logged); Admin → Students → the student → *Recent OTP requests* |
| Video upload fails | the R2 CORS origin must exactly match `https://sprint.yourdomain.com`; the token must have Read & Write on the bucket |
| Locked out of admin | `docker compose exec app node scripts/create-admin.js --email you@yourdomain.com --reset` |
