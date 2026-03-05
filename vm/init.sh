#!/bin/bash
# DeployMagi VM Init Script — runs as PID 1 inside Firecracker VMs
#
# Kernel cmdline passes config as dm.* parameters:
#   dm.ip=172.16.0.X dm.gateway=172.16.0.1 dm.dns=8.8.8.8
#   dm.ssh_keys=<base64> dm.gh_repo=owner/repo dm.gh_token=<token>
#   dm.opencode_password=<pw> dm.openai_api_key=<key>
#   dm.anthropic_api_key=<key> dm.vsock_cid=<cid>
#
# The init script in /sbin/deploymagi-init mounts filesystems and
# parses dm.* params before exec-ing this script.

set -e

echo "[init] DeployMagi VM starting..."

# --- Mount essential filesystems (if not already done by deploymagi-init) ---

mountpoint -q /proc || mount -t proc proc /proc
mountpoint -q /sys || mount -t sysfs sysfs /sys
mountpoint -q /dev || mount -t devtmpfs devtmpfs /dev
mkdir -p /dev/pts /dev/shm /run /tmp
mountpoint -q /dev/pts || mount -t devpts devpts /dev/pts
mountpoint -q /dev/shm || mount -t tmpfs tmpfs /dev/shm
mountpoint -q /run || mount -t tmpfs tmpfs /run
mountpoint -q /tmp || mount -t tmpfs tmpfs /tmp

# --- Parse kernel cmdline ---

# The deploymagi-init wrapper exports DM_* vars from dm.* kernel params.
# If not set, parse them ourselves.
if [ -z "${DM_ip:-}" ]; then
  for param in $(cat /proc/cmdline); do
    case "$param" in
      dm.*)
        key=$(echo "$param" | cut -d= -f1 | sed 's/^dm\./DM_/')
        val=$(echo "$param" | cut -d= -f2-)
        export "$key"="$val"
        ;;
    esac
  done
fi

VM_IP="${DM_ip:-172.16.0.2}"
GATEWAY="${DM_gateway:-172.16.0.1}"
DNS="${DM_dns:-8.8.8.8}"
VSOCK_CID="${DM_vsock_cid:-3}"

# Decode env name from base64 and sanitize for use as directory name
ENV_NAME=""
if [ -n "${DM_env_name:-}" ]; then
  ENV_NAME=$(echo "${DM_env_name}" | base64 -d 2>/dev/null || echo "")
fi
# Sanitize: lowercase, replace non-alphanumeric with hyphens, collapse multiple hyphens
SAFE_DIR_NAME=$(echo "${ENV_NAME:-workspace}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')
[ -z "${SAFE_DIR_NAME}" ] && SAFE_DIR_NAME="workspace"

echo "[init] VM IP: ${VM_IP}, Gateway: ${GATEWAY}, CID: ${VSOCK_CID}, Dir: ${SAFE_DIR_NAME}"

# --- Networking ---

echo "[init] Configuring network..."

# Bring up loopback (needed for localhost-binding services like Claude Code OAuth)
ip link set lo up 2>/dev/null || true

# Configure eth0 (Firecracker's default network interface)
ip addr add "${VM_IP}/16" dev eth0 2>/dev/null || true
ip link set eth0 up 2>/dev/null || true
ip route add default via "${GATEWAY}" 2>/dev/null || true

# DNS
echo "nameserver ${DNS}" > /etc/resolv.conf
echo "nameserver 8.8.4.4" >> /etc/resolv.conf

# Verify connectivity (best-effort, don't block boot)
ping -c1 -W2 "${GATEWAY}" > /dev/null 2>&1 && echo "[init] Gateway reachable" || echo "[init] WARNING: Gateway unreachable"

# --- Swap ---

if [ -f /swapfile ]; then
  swapon /swapfile 2>/dev/null && echo "[init] Swap enabled (1GB)" || echo "[init] WARNING: Failed to enable swap"
fi

# --- SSH Setup ---

echo "[init] Configuring SSH..."

# Unlock the dev account — OpenSSH 10+ rejects pubkey auth for locked accounts
# Alpine's adduser -D sets shadow to "!" (locked); change to "*" (no password)
sed -i 's/^dev:!:/dev:*:/' /etc/shadow

# Decode and write authorized_keys
if [ -n "${DM_ssh_keys:-}" ]; then
  echo "${DM_ssh_keys}" | base64 -d > /home/dev/.ssh/authorized_keys 2>/dev/null || {
    # If not base64, treat as raw
    echo "${DM_ssh_keys}" > /home/dev/.ssh/authorized_keys
  }
  chmod 600 /home/dev/.ssh/authorized_keys
  chown dev:dev /home/dev/.ssh/authorized_keys
fi

# Also install the control plane's internal SSH key if provided
if [ -n "${DM_internal_ssh_key:-}" ]; then
  echo "${DM_internal_ssh_key}" | base64 -d >> /home/dev/.ssh/authorized_keys 2>/dev/null || {
    echo "${DM_internal_ssh_key}" >> /home/dev/.ssh/authorized_keys
  }
fi

# Generate host keys if missing
ssh-keygen -A 2>/dev/null

# Start TCP SSH (for external access)
mkdir -p /run/sshd
/usr/sbin/sshd -e 2>/dev/null &
echo "[init] sshd started on TCP port 22"

# Start vsock SSH listener (for host↔guest exec)
# socat listens on vsock CID:port and forks sshd for each connection
if command -v socat &>/dev/null; then
  socat VSOCK-LISTEN:22,reuseaddr,fork EXEC:"/usr/sbin/sshd -i -e" &
  echo "[init] vsock SSH listener started on CID ${VSOCK_CID}:22"
else
  echo "[init] WARNING: socat not found, vsock SSH unavailable"
fi

# --- Git config ---

su - dev -c 'git config --global user.email "agent@deploymagi.dev"' 2>/dev/null
su - dev -c 'git config --global user.name "Agent"' 2>/dev/null

# --- Clone or pull repo ---

GH_REPO="${DM_gh_repo:-}"
GH_TOKEN="${DM_gh_token:-}"

# Determine working directory — clone into /home/dev/ naturally
WORK_DIR="/home/dev/${SAFE_DIR_NAME}"

if [ -n "${GH_REPO}" ] && [ -n "${GH_TOKEN}" ]; then
  # Extract repo name from owner/repo for the clone target
  REPO_NAME="${GH_REPO##*/}"
  CLONE_DIR="/home/dev/${REPO_NAME}"

  if [ ! -d "${CLONE_DIR}/.git" ]; then
    echo "[init] Cloning ${GH_REPO} into ${CLONE_DIR}..."
    su - dev -c "git clone 'https://x-access-token:${GH_TOKEN}@github.com/${GH_REPO}.git' '${CLONE_DIR}'" 2>/dev/null || {
      echo "[init] WARNING: git clone failed, creating empty workspace"
      su - dev -c "mkdir -p '${WORK_DIR}' && cd '${WORK_DIR}' && git init"
      CLONE_DIR=""
    }
  else
    echo "[init] Repo exists at ${CLONE_DIR}, pulling..."
    su - dev -c "cd '${CLONE_DIR}' && git pull --ff-only" 2>/dev/null || true
  fi

  # Use the cloned repo dir as the working dir
  [ -n "${CLONE_DIR}" ] && WORK_DIR="${CLONE_DIR}"
else
  echo "[init] No GH_REPO/GH_TOKEN, creating empty workspace"
  su - dev -c "mkdir -p '${WORK_DIR}' && cd '${WORK_DIR}' && git init" 2>/dev/null
fi

# --- Persist env vars for SSH sessions ---

cat > /home/dev/.env <<EOF
export GH_REPO="${GH_REPO}"
export GH_TOKEN="${GH_TOKEN}"
export OPENAI_API_KEY="${DM_openai_api_key:-}"
export ANTHROPIC_API_KEY="${DM_anthropic_api_key:-}"
export OPENCODE_SERVER_PASSWORD="${DM_opencode_password:-}"
export DEPLOYMAGI_WORK_DIR="${WORK_DIR}"
EOF

# Source .env in bashrc if not already
grep -q 'source ~/.env' /home/dev/.bashrc 2>/dev/null || {
  echo 'source ~/.env 2>/dev/null' >> /home/dev/.bashrc
}
chown dev:dev /home/dev/.env /home/dev/.bashrc

# Pre-start OpenCode server so it's ready when the user creates a session
# (avoids ~3s cold-start delay on first session creation)
if command -v opencode &>/dev/null && [ -n "${DM_opencode_password:-}" ]; then
  su - dev -c "source ~/.env 2>/dev/null; cd '${WORK_DIR}' 2>/dev/null || cd ~; OPENCODE_SERVER_PASSWORD='${DM_opencode_password}' nohup opencode serve --port 5000 --hostname 0.0.0.0 > /tmp/opencode.log 2>&1 & disown" &
  echo "[init] OpenCode server starting in background on port 5000 (cwd: ${WORK_DIR})"
fi

# --- Start user app (best-effort) ---

cd "${WORK_DIR}" 2>/dev/null || true
export PORT=3000

if [ -f package.json ]; then
  echo "[init] Starting Node.js app..."
  su - dev -c "cd '${WORK_DIR}' && npm install 2>/dev/null && pm2 start npm --name app -- start" 2>/dev/null || true
elif [ -f requirements.txt ]; then
  pip install -r requirements.txt --break-system-packages 2>/dev/null || true
  [ -f app.py ] && su - dev -c "cd '${WORK_DIR}' && pm2 start 'python3 app.py' --name app" 2>/dev/null || true
fi

echo "[init] DeployMagi VM ready"

# --- Keep PID 1 alive ---
# Use a wait loop that handles signals for clean shutdown

_shutdown() {
  echo "[init] Shutting down..."
  # Stop services gracefully
  su - dev -c 'pm2 kill' 2>/dev/null || true
  kill $(jobs -p) 2>/dev/null || true
  sync
  echo "[init] Goodbye"
  exit 0
}

trap _shutdown SIGTERM SIGINT SIGQUIT

# Wait forever (PID 1 must not exit)
while true; do
  sleep 3600 &
  wait $! || true
done
