#!/usr/bin/env bash
set -euo pipefail

# DeployMagi deploy script
# Usage: ./deploy.sh [flags]
#   --skip-build        Skip dashboard + admin build
#   --dashboard-only    Only deploy dashboard
#   --admin-only        Only deploy admin dashboard
#   --auth-only         Only deploy and restart auth service
#   --cp-only           Only deploy and restart control plane
#   --install-services  Install systemd units and migrate from nohup (one-time)

REMOTE="deploymagi"
REMOTE_DIR="/home/ubuntu/deploymagi"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Parse flags
SKIP_BUILD=false
DASHBOARD_ONLY=false
ADMIN_ONLY=false
AUTH_ONLY=false
CP_ONLY=false
INSTALL_SERVICES=false

for arg in "$@"; do
  case "$arg" in
    --skip-build)       SKIP_BUILD=true ;;
    --dashboard-only)   DASHBOARD_ONLY=true ;;
    --admin-only)       ADMIN_ONLY=true ;;
    --auth-only)        AUTH_ONLY=true ;;
    --cp-only)          CP_ONLY=true ;;
    --install-services) INSTALL_SERVICES=true ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $*"; }
err()  { echo -e "${RED}[deploy]${NC} $*"; exit 1; }

# Step 1: Write version.json
log "Writing version.json..."
cat > "$SCRIPT_DIR/version.json" <<EOF
{
  "commit": "$(git -C "$SCRIPT_DIR" rev-parse --short HEAD)",
  "branch": "$(git -C "$SCRIPT_DIR" rev-parse --abbrev-ref HEAD)",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "deployer": "$(whoami)"
}
EOF
cat "$SCRIPT_DIR/version.json"

# Step 2: Build dashboard + admin (unless skipped or not needed)
if [[ "$SKIP_BUILD" == false && "$AUTH_ONLY" == false && "$CP_ONLY" == false ]]; then
  if [[ "$ADMIN_ONLY" == false ]]; then
    log "Building dashboard..."
    (cd "$SCRIPT_DIR/dashboard" && npm run build)
  fi
  if [[ "$DASHBOARD_ONLY" == false ]]; then
    log "Building admin dashboard..."
    (cd "$SCRIPT_DIR/admin" && npm run build)
  fi
else
  log "Skipping builds"
fi

# Step 3: Rsync
log "Syncing files to $REMOTE..."
rsync -avz --delete \
  --exclude-from="$SCRIPT_DIR/.rsyncignore" \
  "$SCRIPT_DIR/" "$REMOTE:$REMOTE_DIR/"

# Step 4: npm install on server (node_modules excluded from rsync)
log "Running npm install on server..."
ssh "$REMOTE" "cd $REMOTE_DIR && npm install 2>&1 | tail -3"

# Step 5: Install systemd services (one-time migration)
if [[ "$INSTALL_SERVICES" == true ]]; then
  log "Installing systemd services..."
  ssh "$REMOTE" "sudo bash -s" <<'REMOTE_SCRIPT'
set -e
cp /home/ubuntu/deploymagi/infra/systemd/deploymagi-auth.service /etc/systemd/system/
cp /home/ubuntu/deploymagi/infra/systemd/deploymagi-control-plane.service /etc/systemd/system/
cp /home/ubuntu/deploymagi/infra/systemd/deploymagi-dashboard.service /etc/systemd/system/
cp /home/ubuntu/deploymagi/infra/systemd/deploymagi-admin.service /etc/systemd/system/
systemctl daemon-reload

# Kill old nohup processes
echo "Stopping old nohup processes..."
pkill -f "tsx auth/server.ts" 2>/dev/null || true
pkill -f "tsx control-plane/server.ts" 2>/dev/null || true
pkill -f "serve -s dist -l 4002" 2>/dev/null || true
pkill -f "serve -s dist -l 4003" 2>/dev/null || true
sleep 2

# Enable and start services
systemctl enable deploymagi-auth deploymagi-control-plane deploymagi-dashboard deploymagi-admin
systemctl start deploymagi-auth
echo "Auth service started"
sleep 3
systemctl start deploymagi-control-plane
echo "Control plane started"
sleep 2
systemctl start deploymagi-dashboard
echo "Dashboard started"
systemctl start deploymagi-admin
echo "Admin dashboard started"
REMOTE_SCRIPT
  log "Systemd services installed and started"
fi

# Step 6: Restart services
wait_for_health() {
  local name="$1" url="$2" max_attempts="${3:-15}"
  for i in $(seq 1 "$max_attempts"); do
    if ssh "$REMOTE" "curl -sf '$url' > /dev/null 2>&1"; then
      log "$name is healthy"
      return 0
    fi
    sleep 2
  done
  err "$name failed health check after $((max_attempts * 2))s"
}

restart_auth() {
  log "Restarting auth service..."
  ssh "$REMOTE" "sudo systemctl restart deploymagi-auth"
  wait_for_health "Auth" "http://localhost:4000/health"
}

restart_cp() {
  log "Restarting control plane..."
  ssh "$REMOTE" "sudo systemctl restart deploymagi-control-plane"
  wait_for_health "Control plane" "http://localhost:4001/health"
}

restart_dashboard() {
  log "Restarting dashboard..."
  ssh "$REMOTE" "sudo systemctl restart deploymagi-dashboard"
  wait_for_health "Dashboard" "http://localhost:4002" 10
}

restart_admin() {
  log "Restarting admin dashboard..."
  ssh "$REMOTE" "sudo systemctl restart deploymagi-admin"
  wait_for_health "Admin" "http://localhost:4003" 10
}

if [[ "$INSTALL_SERVICES" == false ]]; then
  if [[ "$DASHBOARD_ONLY" == true ]]; then
    restart_dashboard
  elif [[ "$ADMIN_ONLY" == true ]]; then
    restart_admin
  elif [[ "$AUTH_ONLY" == true ]]; then
    restart_auth
  elif [[ "$CP_ONLY" == true ]]; then
    restart_cp
  else
    restart_auth
    restart_cp
    restart_dashboard
    restart_admin
  fi
fi

# Step 7: Smoke tests
log "Running smoke tests..."

# Verify version in health endpoints
if [[ "$DASHBOARD_ONLY" != true && "$ADMIN_ONLY" != true ]]; then
  COMMIT=$(jq -r .commit "$SCRIPT_DIR/version.json")

  AUTH_VERSION=$(ssh "$REMOTE" "curl -sf http://localhost:4000/health | jq -r '.version.commit // empty'" 2>/dev/null || echo "")
  if [[ "$AUTH_VERSION" == "$COMMIT" ]]; then
    log "Auth version verified: $COMMIT"
  else
    warn "Auth version mismatch: expected $COMMIT, got ${AUTH_VERSION:-empty}"
  fi

  CP_VERSION=$(ssh "$REMOTE" "curl -sf http://localhost:4001/health | jq -r '.version.commit // empty'" 2>/dev/null || echo "")
  if [[ "$CP_VERSION" == "$COMMIT" ]]; then
    log "Control plane version verified: $COMMIT"
  else
    warn "Control plane version mismatch: expected $COMMIT, got ${CP_VERSION:-empty}"
  fi
fi

# CORS preflight check
CORS_STATUS=$(ssh "$REMOTE" "curl -sf -o /dev/null -w '%{http_code}' -X OPTIONS -H 'Origin: http://localhost:4002' -H 'Access-Control-Request-Method: GET' http://localhost:4001/health" 2>/dev/null || echo "000")
if [[ "$CORS_STATUS" == "204" || "$CORS_STATUS" == "200" ]]; then
  log "CORS preflight OK ($CORS_STATUS)"
else
  warn "CORS preflight returned $CORS_STATUS"
fi

log "Deploy complete!"
ssh "$REMOTE" "sudo systemctl status deploymagi-auth deploymagi-control-plane deploymagi-dashboard deploymagi-admin --no-pager -l" 2>/dev/null | head -40 || true
