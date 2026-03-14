#!/bin/bash
# NumaVM App — git clone, env files, app startup
# Runs as a oneshot systemd service after numavm-setup.
set -e

# --- Parse kernel cmdline ---
source /opt/numavm/parse-cmdline.sh

# Decode env name and sanitize for directory name
ENV_NAME=""
if [ -n "${DM_env_name:-}" ]; then
  ENV_NAME=$(echo "${DM_env_name}" | base64 -d 2>/dev/null || echo "")
fi
SAFE_DIR_NAME=$(echo "${ENV_NAME:-workspace}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')
[ -z "${SAFE_DIR_NAME}" ] && SAFE_DIR_NAME="workspace"

# --- Git config (parallel) ---
{
  sudo -u dev git config --global user.email "agent@numavm.dev" 2>/dev/null
  sudo -u dev git config --global user.name "Agent" 2>/dev/null
} &
GIT_CONFIG_PID=$!

# --- Clone or pull repo ---

GH_REPO="${DM_gh_repo:-}"
GH_TOKEN="${DM_gh_token:-}"
WORK_DIR="/home/dev/${SAFE_DIR_NAME}"

if [ -n "${GH_REPO}" ] && [ -n "${GH_TOKEN}" ]; then
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

  [ -n "${CLONE_DIR}" ] && WORK_DIR="${CLONE_DIR}"
elif [ -n "${GH_REPO}" ]; then
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

grep -q 'source ~/.env' /home/dev/.bashrc 2>/dev/null || {
  echo 'source ~/.env 2>/dev/null' >> /home/dev/.bashrc
}

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

# Git credential helper
if [ -n "${GH_TOKEN}" ]; then
  sudo -u dev git config --global credential.helper '!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f'
  sudo -u dev git config --global user.name "${DM_github_username:-dev}"
fi

chown dev:dev /home/dev/.env /home/dev/.bashrc /home/dev/.ssh/environment

# --- Write extra init files ---
if [ -n "${DM_init_files:-}" ]; then
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
  echo "${DM_extra_env}" | base64 -d | sed 's/^export //' >> /home/dev/.ssh/environment
fi

# --- Write AGENTS.md ---
if [ -f /etc/numavm/BASE_AGENTS.md ] && [ -d "${WORK_DIR}" ]; then
  sed "s/{{VM_NAME}}/${ENV_NAME:-workspace}/g" /etc/numavm/BASE_AGENTS.md > "${WORK_DIR}/AGENTS.md"
  chown dev:dev "${WORK_DIR}/AGENTS.md"
fi

# --- Start user app (best-effort) ---

cd "${WORK_DIR}" 2>/dev/null || true
export PORT=3000

patch_vite_allowed_hosts() {
  local dir="$1"
  for cfg in "${dir}/vite.config.ts" "${dir}/vite.config.js" "${dir}/vite.config.mts" "${dir}/vite.config.mjs"; do
    if [ -f "$cfg" ]; then
      if ! grep -q 'allowedHosts' "$cfg" 2>/dev/null; then
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

  has_script() {
    grep -q "\"$1\"[[:space:]]*:" "$pkg" 2>/dev/null
  }

  local start_script
  start_script=$(grep -o '"start"[[:space:]]*:[[:space:]]*"[^"]*"' "$pkg" | head -1 | sed 's/.*: *"//;s/"$//')

  if [ -n "$start_script" ]; then
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

    if grep -q '"astro"' "$pkg" 2>/dev/null && echo "$start_script" | grep -qE 'dev|preview'; then
      echo "npm start -- --port 3000"
      return 0
    fi

    echo "npm start"
    return 0
  fi

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

  patch_vite_allowed_hosts "${WORK_DIR}"

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
