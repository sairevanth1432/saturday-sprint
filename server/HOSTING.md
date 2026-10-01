# Hosting options

The same code runs in three ways. Nothing in the app changes; only configuration does.

| Way | Where | Database | Cache | Videos |
|---|---|---|---|---|
| **Docker** (`docker-compose.yml`) | any Linux VM: Oracle Cloud Free, AWS/GCP/Azure, DigitalOcean, Hetzner, on-prem | Postgres container | Redis container | Cloudflare R2 (or any S3) |
| **Vercel** (`vercel.json`) | serverless | Neon | Upstash | Vercel Blob or R2 |
| **Single process** (`npm start`) | your laptop / a test box | PGlite (built in) | memory | local disk |

## Can it be free at 15,000 simultaneous students?

**Mostly yes, with one free virtual machine and Cloudflare. There is no guarantee, and you must load-test it first.** The serverless free tiers are too small:

| Free tier | Limit that breaks at 15k students |
|---|---|
| Vercel Hobby | Non-commercial use only, cron once a day, 10 GB Blob transfer |
| Render free | Sleeps after 15 min idle (~1 min to wake up), small instance |
| Neon free | 0.5 GB storage, 100 compute-hours, 5 GB transfer per month |
| Upstash free | 500,000 commands/month. **One** Sprint needs ~2–3 million (autosave). |

What *is* generous enough:
- **Oracle Cloud Always Free:** an Arm VM with **2 OCPU / 12 GB RAM**. Oracle cut this from 4/24 on 15 June 2026.
- **Cloudflare R2:** **10 GB storage free and no charge for bandwidth**, so serving videos to 15k students costs nothing as long as all videos fit in 10 GB.
- **Cloudflare DNS + proxy:** free.

### Recommended free setup

```
students ──► Cloudflare (DNS, optional proxy, free) ──► Oracle Always Free VM (2 OCPU / 12 GB)
                                                          └─ docker compose: Caddy (HTTPS) → Node ×2 → Postgres + Redis
students ──► Cloudflare R2 (videos, free egress)
```

**Measured:** grading one coding answer takes ~4 ms of CPU. All 15k submissions need under a minute of CPU on 2 cores, and an infinite loop is cut off after ~2 s. The heaviest steady load is autosave (~900 requests/s), and that goes to Redis.

**Honest risks**
- **Single machine:** if the VM goes down, the Sprint stops. There is no automatic failover.
- **Oracle Free:** Arm capacity is sometimes "out of capacity" in busy regions. Oracle can reclaim idle Always Free instances and has changed limits without notice. No SLA.
- **2 cores at the 11:00 burst is the edge:** run the load simulator (below) at full scale **before** the event.
- **Backups are your job** (see below).

If the load test is not comfortable, move the **same Docker setup** to a bigger paid VM (more cores → raise `WEB_CONCURRENCY`) for the event day only. There are no code changes, and you can return to the free VM afterwards.

## Step by step: Oracle Cloud Free + Cloudflare R2

### 1. Server
1. Create an Oracle Cloud account and an **Always Free** instance: shape *VM.Standard.A1.Flex*, 2 OCPU / 12 GB, Ubuntu 24.04, in the region closest to your students (Mumbai or Hyderabad).
2. Allow ports 80 and 443:
   - In the VCN **Security List** (ingress rules).
   - On the VM itself (Ubuntu images block them by default):
     ```bash
     sudo iptables -I INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT && sudo netfilter-persistent save
     ```
3. Install Docker:
   ```bash
   curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER
   ```
   Log out and back in.
4. Copy the **"Saturday Sprint"** folder to the VM (git clone or scp). It must contain `saturday_sprint_portal*.html` and `server/`.
5. Point your domain at the VM: a DNS **A record** for `sprint.example.com` → the VM's public IP.

### 2. Video storage (Cloudflare R2)
1. In the Cloudflare dashboard, go to **R2 → Create bucket** (e.g. `learning-bytes`).
2. Bucket → **Settings → Public access**:
   - Connect a **custom domain** (e.g. `videos.example.com`) for production.
   - The `r2.dev` URL is for testing only; it is rate-limited.
3. Bucket → **Settings → CORS policy** (lets the admin console upload directly):
   ```json
   [{ "AllowedOrigins": ["https://sprint.example.com"], "AllowedMethods": ["PUT", "GET"], "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3600 }]
   ```
4. **R2 → Manage API tokens → Create token** with *Object Read & Write* on this bucket. Note the Access Key ID, the Secret, and the S3 endpoint `https://<account-id>.r2.cloudflarestorage.com`.

### 3. Configure and start
```bash
cd "Saturday Sprint/server"
cp .env.example .env
nano .env
```
Set at least:
- `DOMAIN`, `POSTGRES_PASSWORD`, `APP_SECRET`, `WEB_CONCURRENCY=2`
- `OTP_PROVIDER` (+ its keys)
- `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_URL`

Then start everything and create the first admin:
```bash
docker compose up -d --build
docker compose exec app node scripts/create-admin.js --email you@nxtwave.co.in --super
```
Open `https://sprint.example.com/api/health`. It should show `db: postgres`, `redis: redis`, `storage: s3`.

### 4. Content
- **Master list:** Admin → Master data → upload CSV. Or copy it to `server/data/students.csv` on the VM; it is watched and imported automatically.
- **Videos:** Admin → Learning bytes → Upload MP4 (stored in R2). Or copy `<lessonId>.mp4` files into `server/public/learning-bytes/` on the VM, but those are then served by the VM itself, so R2 is better for 15k students.

### 5. Optional: Cloudflare proxy in front of the VM
Turning on the orange-cloud proxy for `sprint.example.com` hides the VM's IP and absorbs attacks for free. Then:
- Set `TRUST_PROXY=2`.
- Set SSL mode to **Full (strict)**.

Keep videos on R2 rather than proxying video files through the VM.

## Backups (self-hosted)
```bash
# nightly at 02:00 — add with: crontab -e
0 2 * * * cd "/home/ubuntu/Saturday Sprint/server" && docker compose exec -T db pg_dump -U sprint sprint | gzip > ~/backup-$(date +\%F).sql.gz
```
Copy the backups off the VM, for example to another R2 bucket. Restore with:
```bash
gunzip -c backup.sql.gz | docker compose exec -T db psql -U sprint sprint
```

## Load test before the event (any hosting)
See README.md → *Load test before the event*. Use a staging copy:
- a second compose project, or the same VM before going live, with its own database
- `ALLOW_TEST_OTP=true`
- 15,000 test students driven from several machines

Watch `docker stats` on the VM while the test runs.

## Updating
```bash
git pull
docker compose up -d --build
```
The app rebuilds the portal and questions inside the image. Data in the volumes (Postgres, Redis, `server/data`) is kept.
