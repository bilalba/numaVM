#!/bin/bash
set -e

# MOTD
cat > /etc/motd <<'MOTD'
  _   _                     __     ____  __
 | \ | |_   _ _ __ ___   __ \ \   / /  \/  |
 |  \| | | | | '_ ` _ \ / _` \ \ / /| |\/| |
 | |\  | |_| | | | | | | (_| |\ V / | |  | |
 |_| \_|\__,_|_| |_| |_|\__,_| \_/  |_|  |_|

  Run `claude` in ~/repo to start Claude Code.
  Run `codex` for Codex, `opencode` for OpenCode.

  Your GitHub SSH keys are pre-configured.
  Set ANTHROPIC_API_KEY or run `claude /login` to authenticate.
MOTD

# SSH Setup
echo "${SSH_AUTHORIZED_KEYS}" > /home/dev/.ssh/authorized_keys
chmod 600 /home/dev/.ssh/authorized_keys
chown -R dev:dev /home/dev/.ssh
/usr/sbin/sshd

# Git config
su - dev -c 'git config --global user.email "agent@numavm.dev"'
su - dev -c 'git config --global user.name "Agent"'

# Clone or pull repo
if [ ! -d /data/repo/.git ]; then
  if [ -n "${GH_REPO}" ] && [ -n "${GH_TOKEN}" ]; then
    git clone "https://x-access-token:${GH_TOKEN}@github.com/${GH_REPO}.git" /data/repo || {
      echo "Warning: git clone failed, creating empty repo"
      mkdir -p /data/repo && cd /data/repo && git init
    }
  else
    echo "No GH_REPO or GH_TOKEN set, creating empty repo"
    mkdir -p /data/repo && cd /data/repo && git init
  fi
  chown -R dev:dev /data/repo
else
  cd /data/repo && git pull --ff-only || true
fi

ln -sf /data/repo /home/dev/repo
chown -R dev:dev /data

# Persist env vars for SSH sessions
cat > /home/dev/.env <<EOF
export GH_REPO="${GH_REPO}"
export GH_TOKEN="${GH_TOKEN}"
export OPENAI_API_KEY="${OPENAI_API_KEY}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
EOF
echo 'source ~/.env 2>/dev/null' >> /home/dev/.bashrc
chown dev:dev /home/dev/.env /home/dev/.bashrc

# Start OpenCode server
export OPENCODE_SERVER_PASSWORD="${OPENCODE_PASSWORD}"
nohup opencode serve --port 5000 --hostname 0.0.0.0 > /tmp/opencode.log 2>&1 &

# Start app if it exists
cd /data/repo || true
export PORT=4000
if [ -f package.json ]; then
  su - dev -c 'cd /data/repo && npm install 2>/dev/null && pm2 start npm --name app -- start' || true
elif [ -f requirements.txt ]; then
  pip install -r requirements.txt --break-system-packages 2>/dev/null
  [ -f app.py ] && su - dev -c 'cd /data/repo && pm2 start "python3 app.py" --name app' || true
fi

tail -f /dev/null
