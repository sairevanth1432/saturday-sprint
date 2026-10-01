#!/usr/bin/env bash
# Safe production update for the Docker setup. Run ON THE SERVER, inside the server/ folder:
#
#   bash scripts/deploy.sh              update to the latest code on the main branch
#   bash scripts/deploy.sh v1.4         deploy a specific tag/commit (also how you roll back)
#   bash scripts/deploy.sh --force      deploy even while a Sprint is running (avoid!)
#
# Steps: refuse during a live Sprint → back up the database → get the code → rebuild → restart
#        → health check → if unhealthy, automatically go back to the previous version.
set -euo pipefail
cd "$(dirname "$0")/.."

FORCE=0; REF=""
for a in "$@"; do if [ "$a" = "--force" ]; then FORCE=1; else REF="$a"; fi; done

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
healthy() {
  docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
}

# 1. Never restart in the middle of a Sprint (30 min margin on both sides) unless forced.
if [ "$FORCE" -eq 0 ] && docker compose ps --status running app >/dev/null 2>&1; then
  if ! docker compose exec -T app node -e "
    import('./sprint.js').then(async (m) => {
      const s = await m.getSprint(), now = Date.now(), pad = 30 * 60000;
      if (now > s.openMs - pad && now < s.closeMs + pad) { console.log('A Sprint is open or about to open (' + s.open + ' – ' + s.close + ').'); process.exit(3); }
      process.exit(0);
    }).catch(() => process.exit(0));"; then
    echo "Refusing to deploy during the Sprint window. Wait until it closes, or add --force."
    exit 3
  fi
fi

PREV=$(git rev-parse HEAD)
say "Current version: $(git log -1 --format='%h %s' "$PREV")"

# 2. Backup (kept in ~/backups; restore instructions in CHANGES.md)
mkdir -p ~/backups
BACKUP=~/backups/before-deploy-$(date +%F-%H%M%S).sql.gz
say "Backing up the database → $BACKUP"
docker compose exec -T db pg_dump -U sprint sprint | gzip > "$BACKUP"

# 3. Get the code
say "Fetching code"
git fetch --all --tags --prune
if [ -n "$REF" ]; then git checkout --quiet "$REF"; else git checkout --quiet main && git pull --ff-only; fi
NEW=$(git rev-parse HEAD)
if [ "$NEW" = "$PREV" ]; then say "Already up to date ($(git log -1 --format='%h %s'))."; fi
say "Deploying: $(git log -1 --format='%h %s')"

# 4. Build and restart only the app (database, Redis and HTTPS keep running)
docker compose build app
docker compose up -d app

# 5. Health check (up to ~60 s); roll back automatically on failure
say "Checking health"
for i in $(seq 1 30); do
  if healthy; then
    say "Deployed $(git log -1 --format='%h %s') ✔"
    docker image prune -f >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 2
done

say "Health check FAILED — rolling back to $(git log -1 --format='%h %s' "$PREV")"
docker compose logs --tail=60 app || true
git checkout --quiet "$PREV"
docker compose build app
docker compose up -d app
for i in $(seq 1 30); do if healthy; then say "Rolled back. The site is running the previous version."; exit 1; fi; sleep 2; done
say "Rollback did not become healthy either. Check: docker compose logs app"
exit 2
