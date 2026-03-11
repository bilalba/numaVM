#!/bin/bash
# NumaVM VM Init Script — runs as PID 1 inside Firecracker VMs
#
# Kernel cmdline passes config as dm.* parameters:
#   dm.ip=172.16.0.X dm.gateway=172.16.0.1 dm.dns=8.8.8.8
#   dm.ssh_keys=<base64> dm.gh_repo=owner/repo dm.gh_token=<token>
#   dm.opencode_password=<pw> dm.openai_api_key=<key>
#   dm.anthropic_api_key=<key> dm.vsock_cid=<cid>
#
# The init script in /sbin/numavm-init mounts filesystems and
# parses dm.* params before exec-ing this script.

set -e

# --- Mount essential filesystems (if not already done by numavm-init) ---

mountpoint -q /proc || mount -t proc proc /proc
mountpoint -q /sys || mount -t sysfs sysfs /sys
mountpoint -q /dev || mount -t devtmpfs devtmpfs /dev
mkdir -p /dev/pts /dev/shm /run /tmp
mountpoint -q /dev/pts || mount -t devpts devpts /dev/pts
mountpoint -q /dev/shm || mount -t tmpfs tmpfs /dev/shm
mountpoint -q /run || mount -t tmpfs tmpfs /run
mountpoint -q /tmp || mount -t tmpfs tmpfs /tmp


# --- Parse kernel cmdline ---

# The numavm-init wrapper exports DM_* vars from dm.* kernel params.
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


# --- Networking ---

# Bring up loopback (needed for localhost-binding services like Claude Code OAuth)
ip link set lo up 2>/dev/null || true

# Configure eth0 (Firecracker's default network interface)
ip addr add "${VM_IP}/16" dev eth0 2>/dev/null || true
ip link set eth0 up 2>/dev/null || true
ip route add default via "${GATEWAY}" 2>/dev/null || true

# IPv6 (only if dm.ipv6 was passed via kernel cmdline)
if [ -n "${DM_ipv6:-}" ]; then
  IPV6_PREFIX_LEN="${DM_ipv6_prefix_len:-64}"
  ip -6 addr add "${DM_ipv6}/${IPV6_PREFIX_LEN}" dev eth0 2>/dev/null || true
  # Derive gateway: replace the last component (our CID) with "1"
  # e.g. fd00::3 → fd00::1
  IPV6_GW=$(echo "${DM_ipv6}" | sed 's/::[0-9a-fA-F]*$/::1/')
  ip -6 route add default via "${IPV6_GW}" 2>/dev/null || true
fi

# DNS
echo "nameserver ${DNS}" > /etc/resolv.conf
echo "nameserver 8.8.4.4" >> /etc/resolv.conf


# --- Swap ---

if [ -f /swapfile ]; then
  swapon /swapfile 2>/dev/null && true || true
fi

# --- SSH Setup ---

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

# Host keys and sshd_config (including PermitUserEnvironment) are pre-baked
# into the rootfs by build-rootfs.sh. No ssh-keygen -A needed.

# Start TCP SSH (for external access)
mkdir -p /run/sshd
/usr/sbin/sshd -e 2>/dev/null &


# Wait for sshd to actually bind port 22 before signaling the host.
# sshd is backgrounded above — it needs a moment to load keys and bind.
# Check /proc/net/tcp for port 22 (0x0016) in LISTEN state (0A). Zero deps.
while ! grep -q ':0016 .*0A' /proc/net/tcp 2>/dev/null; do
  sleep 0.01
done


# Signal the host that we're ready via vsock (best-effort).
# Falls back gracefully if no host listener is present.
/usr/local/bin/vsock-signal 2>/dev/null || true


# --- Git config + env files (parallel with git clone) ---

{
  sudo -u dev git config --global user.email "agent@numavm.dev" 2>/dev/null
  sudo -u dev git config --global user.name "Agent" 2>/dev/null
} &
GIT_CONFIG_PID=$!

# --- Clone or pull repo ---

GH_REPO="${DM_gh_repo:-}"
GH_TOKEN="${DM_gh_token:-}"

# Determine working directory — clone into /home/dev/ naturally
WORK_DIR="/home/dev/${SAFE_DIR_NAME}"

if [ -n "${GH_REPO}" ] && [ -n "${GH_TOKEN}" ]; then
  # Authenticated clone (private or user-connected repos)
  REPO_NAME="${GH_REPO##*/}"
  CLONE_DIR="/home/dev/${REPO_NAME}"

  if [ ! -d "${CLONE_DIR}/.git" ]; then
    echo "cloning" > /tmp/init-progress
    sudo -u dev bash -lc "git clone 'https://x-access-token:${GH_TOKEN}@github.com/${GH_REPO}.git' '${CLONE_DIR}'" 2>/dev/null || {
      sudo -u dev bash -lc "mkdir -p '${WORK_DIR}' && cd '${WORK_DIR}' && git init"
      CLONE_DIR=""
    }
  else
    sudo -u dev bash -lc "cd '${CLONE_DIR}' && git pull --ff-only" 2>/dev/null || true
  fi

  # Use the cloned repo dir as the working dir
  [ -n "${CLONE_DIR}" ] && WORK_DIR="${CLONE_DIR}"
elif [ -n "${GH_REPO}" ]; then
  # Public clone (no token — deploy button flow)
  REPO_NAME="${GH_REPO##*/}"
  CLONE_DIR="/home/dev/${REPO_NAME}"

  if [ ! -d "${CLONE_DIR}/.git" ]; then
    echo "cloning" > /tmp/init-progress
    sudo -u dev bash -lc "git clone 'https://github.com/${GH_REPO}.git' '${CLONE_DIR}'" 2>/dev/null || {
      sudo -u dev bash -lc "mkdir -p '${WORK_DIR}' && cd '${WORK_DIR}' && git init"
      CLONE_DIR=""
    }
  else
    sudo -u dev bash -lc "cd '${CLONE_DIR}' && git pull --ff-only" 2>/dev/null || true
  fi

  [ -n "${CLONE_DIR}" ] && WORK_DIR="${CLONE_DIR}"
else
  sudo -u dev mkdir -p "${WORK_DIR}"
  sudo -u dev git -C "${WORK_DIR}" init 2>/dev/null || true
fi


# Wait for parallel git config
wait $GIT_CONFIG_PID 2>/dev/null || true

# --- Persist env vars for SSH sessions ---

cat > /home/dev/.env <<EOF
export GH_REPO="${GH_REPO}"
export GH_TOKEN="${GH_TOKEN}"
export OPENAI_API_KEY="${DM_openai_api_key:-}"
export ANTHROPIC_API_KEY="${DM_anthropic_api_key:-}"
export OPENCODE_SERVER_PASSWORD="${DM_opencode_password:-}"
export NUMAVM_WORK_DIR="${WORK_DIR}"
export PORT=3000
EOF

# Source .env in bashrc if not already
grep -q 'source ~/.env' /home/dev/.bashrc 2>/dev/null || {
  echo 'source ~/.env 2>/dev/null' >> /home/dev/.bashrc
}

# Also write ~/.ssh/environment for non-interactive SSH sessions (e.g. exec commands, agents)
cat > /home/dev/.ssh/environment <<EOF
GH_REPO=${GH_REPO}
GH_TOKEN=${GH_TOKEN}
OPENAI_API_KEY=${DM_openai_api_key:-}
ANTHROPIC_API_KEY=${DM_anthropic_api_key:-}
OPENCODE_SERVER_PASSWORD=${DM_opencode_password:-}
NUMAVM_WORK_DIR=${WORK_DIR}
PORT=3000
EOF
chmod 600 /home/dev/.ssh/environment

# Set up git credential helper so git clone/push works with GH_TOKEN automatically
if [ -n "${GH_TOKEN}" ]; then
  sudo -u dev git config --global credential.helper '!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f'
  sudo -u dev git config --global user.name "${DM_github_username:-dev}"
fi

chown dev:dev /home/dev/.env /home/dev/.bashrc /home/dev/.ssh/environment

# --- Write extra init files (generic hook for injecting config at boot) ---
if [ -n "${DM_init_files:-}" ]; then
  # DM_init_files is a base64-encoded JSON object: {"path": "base64_content", ...}
  echo "${DM_init_files}" | base64 -d | python3 -c "
import json, sys, os, base64
data = json.load(sys.stdin)
for path, content_b64 in data.items():
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write(base64.b64decode(content_b64).decode())
    if path.startswith('/home/dev'):
        os.system(f'chown dev:dev \"{path}\"')
" 2>/dev/null || true
fi

# --- Append extra env vars ---
if [ -n "${DM_extra_env:-}" ]; then
  echo "${DM_extra_env}" | base64 -d >> /home/dev/.env
  # Also append to .ssh/environment (without 'export ' prefix)
  echo "${DM_extra_env}" | base64 -d | sed 's/^export //' >> /home/dev/.ssh/environment
fi

# Write AGENTS.md into project directory (gives AI agents context about the environment)
if [ -f /etc/numavm/BASE_AGENTS.md ] && [ -d "${WORK_DIR}" ]; then
  cp /etc/numavm/BASE_AGENTS.md "${WORK_DIR}/AGENTS.md"
  chown dev:dev "${WORK_DIR}/AGENTS.md"
fi

# Pre-start OpenCode server so it's ready when the user creates a session
# (avoids ~3s cold-start delay on first session creation)
if command -v opencode &>/dev/null && [ -n "${DM_opencode_password:-}" ]; then
  sudo -u dev bash -lc "source ~/.env 2>/dev/null; cd '${WORK_DIR}' 2>/dev/null || cd ~; OPENCODE_SERVER_PASSWORD='${DM_opencode_password}' nohup opencode serve --port 5000 --hostname 0.0.0.0 > /tmp/opencode.log 2>&1 & disown" &
fi

# --- Start user app (best-effort) ---

cd "${WORK_DIR}" 2>/dev/null || true
export PORT=3000

# Detect framework and build the right start command.
# DNAT routes host appPort → VM port 3000, so we must ensure the app listens there.
# Most frameworks respect PORT=3000 from env. For those that don't (vite dev, astro dev),
# we detect them from package.json and append --port 3000.
# Patch vite/nuxt/svelte-kit configs to allow all hosts (needed for subdomain access).
# --allowedHosts is NOT a valid CLI flag — must be set in config.
patch_vite_allowed_hosts() {
  local dir="$1"
  # Look for vite.config.{ts,js,mts,mjs} or nuxt.config.{ts,js}
  for cfg in "${dir}/vite.config.ts" "${dir}/vite.config.js" "${dir}/vite.config.mts" "${dir}/vite.config.mjs"; do
    if [ -f "$cfg" ]; then
      # Only patch if not already configured
      if ! grep -q 'allowedHosts' "$cfg" 2>/dev/null; then
        # Insert server.allowedHosts into defineConfig (after the opening { of defineConfig)
        sed -i 's/defineConfig(\s*{/defineConfig({ server: { allowedHosts: true },/' "$cfg" 2>/dev/null || true
      fi
      return 0
    fi
  done
  return 1
}

detect_start_cmd() {
  local pkg="${WORK_DIR}/package.json"
  [ -f "$pkg" ] || return 1

  # Helper: check if a script exists in package.json
  has_script() {
    grep -q "\"$1\"[[:space:]]*:" "$pkg" 2>/dev/null
  }

  # Check if there's a start script
  local start_script
  start_script=$(grep -o '"start"[[:space:]]*:[[:space:]]*"[^"]*"' "$pkg" | head -1 | sed 's/.*: *"//;s/"$//')

  if [ -n "$start_script" ]; then
    # Detect frameworks that need explicit --port flag
    case "$start_script" in
      *astro*dev*|*astro*preview*)
        echo "npm start -- --port 3000"
        return 0
        ;;
      *vite*|*nuxt*dev*|*svelte-kit*dev*)
        echo "npm start -- --port 3000 --host 0.0.0.0"
        return 0
        ;;
      *next*dev*)
        echo "npm start -- -p 3000"
        return 0
        ;;
      *remix*dev*)
        echo "npm start -- --port 3000"
        return 0
        ;;
    esac

    # Check devDependencies / dependencies for frameworks (start script may just be "node server.js")
    if grep -q '"astro"' "$pkg" 2>/dev/null && echo "$start_script" | grep -qE 'dev|preview'; then
      echo "npm start -- --port 3000"
      return 0
    fi

    # Default: rely on PORT=3000 env var (works for express, fastify, next start, hono, etc.)
    echo "npm start"
    return 0
  fi

  # No start script — fall back to dev (preview requires a successful build)
  if has_script "dev"; then
    echo "npm run dev -- --port 3000 --host 0.0.0.0"
    return 0
  fi
  if has_script "preview"; then
    echo "npm run preview -- --port 3000 --host 0.0.0.0"
    return 0
  fi

  return 1
}

if [ -f "${WORK_DIR}/package.json" ]; then
  echo "installing" > /tmp/init-progress
  sudo -u dev bash -lc "cd '${WORK_DIR}' && npm install" 2>/dev/null || {
    echo "error:npm install failed" > /tmp/init-progress
  }

  START_CMD=$(detect_start_cmd)

  # Patch vite config to allow subdomain access
  patch_vite_allowed_hosts "${WORK_DIR}"

  # Only run build if we have a start script (not falling back to dev mode)
  # Dev mode (npm run dev) doesn't need a build step
  if [ -n "$START_CMD" ] && ! echo "$START_CMD" | grep -q 'npm run dev'; then
    if grep -q '"build"' "${WORK_DIR}/package.json" 2>/dev/null; then
      echo "building" > /tmp/init-progress
      sudo -u dev bash -lc "cd '${WORK_DIR}' && source ~/.env 2>/dev/null && npm run build" 2>/dev/null || {
        echo "error:build failed" > /tmp/init-progress
      }
    fi
  fi

  echo "starting" > /tmp/init-progress
  sudo -u dev bash -lc "cd '${WORK_DIR}' && source ~/.env 2>/dev/null && pm2 start '${START_CMD}' --name app" 2>/dev/null || {
    echo "error:app failed to start" > /tmp/init-progress
  }
elif [ -f "${WORK_DIR}/requirements.txt" ]; then
  echo "installing" > /tmp/init-progress
  pip install -r "${WORK_DIR}/requirements.txt" --break-system-packages 2>/dev/null || true
  if [ -f "${WORK_DIR}/app.py" ]; then
    echo "starting" > /tmp/init-progress
    sudo -u dev bash -lc "cd '${WORK_DIR}' && pm2 start 'PORT=3000 python3 app.py' --name app" 2>/dev/null || true
  fi
fi

echo "ready" > /tmp/init-progress

# --- Keep PID 1 alive ---
# Use a wait loop that handles signals for clean shutdown

_shutdown() {
  echo "[init] Shutting down..."
  # Stop services gracefully
  sudo -u dev bash -lc 'pm2 kill' 2>/dev/null || true
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
