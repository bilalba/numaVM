#!/bin/bash
set -euo pipefail

# DeployMagi — Build Alpine Rootfs for Firecracker
#
# Builds a minimal Alpine ext4 rootfs image with all packages pre-installed.
# This image is used as the read-only base layer; each VM gets a writable
# overlay on top.
#
# Usage: sudo ./build-rootfs.sh [output-path]
# Requires: root, debootstrap or alpine-make-rootfs, e2fsprogs

OUTPUT="${1:-/opt/firecracker/rootfs/base.ext4}"
ROOTFS_SIZE_MB="${ROOTFS_SIZE_MB:-4096}"
ALPINE_VERSION="${ALPINE_VERSION:-3.21}"
ALPINE_MIRROR="${ALPINE_MIRROR:-https://dl-cdn.alpinelinux.org/alpine}"
ARCH="$(uname -m)"

# Map arch for Alpine
case "$ARCH" in
  x86_64) ALPINE_ARCH="x86_64" ;;
  aarch64) ALPINE_ARCH="aarch64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

echo "=== Building Alpine Rootfs ==="
echo "Output: ${OUTPUT}"
echo "Size: ${ROOTFS_SIZE_MB}MB"
echo "Alpine: ${ALPINE_VERSION} (${ALPINE_ARCH})"
echo ""

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: Must run as root (sudo)" >&2
  exit 1
fi

# Create output directory
mkdir -p "$(dirname "${OUTPUT}")"

# Working directory
WORKDIR=$(mktemp -d)
MOUNTDIR="${WORKDIR}/rootfs"
mkdir -p "${MOUNTDIR}"

cleanup() {
  echo "Cleaning up..."
  umount "${MOUNTDIR}/proc" 2>/dev/null || true
  umount "${MOUNTDIR}/sys" 2>/dev/null || true
  umount "${MOUNTDIR}/dev" 2>/dev/null || true
  umount "${MOUNTDIR}" 2>/dev/null || true
  losetup -D 2>/dev/null || true
  rm -rf "${WORKDIR}"
}
trap cleanup EXIT

# --- Create ext4 image ---

echo "Creating ${ROOTFS_SIZE_MB}MB ext4 image..."
dd if=/dev/zero of="${OUTPUT}" bs=1M count="${ROOTFS_SIZE_MB}" status=progress
mkfs.ext4 -F -L deploymagi-root "${OUTPUT}"

# Mount it
LOOP=$(losetup --find --show "${OUTPUT}")
mount "${LOOP}" "${MOUNTDIR}"

# --- Bootstrap Alpine ---

echo "Bootstrapping Alpine Linux ${ALPINE_VERSION}..."

# Download and extract Alpine minirootfs
MINIROOTFS_URL="${ALPINE_MIRROR}/v${ALPINE_VERSION}/releases/${ALPINE_ARCH}/alpine-minirootfs-${ALPINE_VERSION}.0-${ALPINE_ARCH}.tar.gz"
echo "Downloading: ${MINIROOTFS_URL}"
curl -fsSL "${MINIROOTFS_URL}" | tar -xz -C "${MOUNTDIR}"

# Set up resolv.conf for package installation
cp /etc/resolv.conf "${MOUNTDIR}/etc/resolv.conf"

# Mount proc/sys/dev for chroot
mount -t proc proc "${MOUNTDIR}/proc"
mount -t sysfs sys "${MOUNTDIR}/sys"
mount --bind /dev "${MOUNTDIR}/dev"

# Configure Alpine repositories
# Use edge for Node.js + matching libssl/libcrypto
cat > "${MOUNTDIR}/etc/apk/repositories" <<EOF
${ALPINE_MIRROR}/v${ALPINE_VERSION}/main
${ALPINE_MIRROR}/v${ALPINE_VERSION}/community
${ALPINE_MIRROR}/edge/main
${ALPINE_MIRROR}/edge/community
${ALPINE_MIRROR}/edge/testing
EOF

# --- Install packages ---

echo "Installing packages..."

chroot "${MOUNTDIR}" apk update

# Core system
chroot "${MOUNTDIR}" apk add --no-cache \
  bash coreutils util-linux \
  openrc \
  openssh openssh-server \
  sudo shadow \
  curl wget jq \
  git tmux \
  python3 py3-pip \
  build-base \
  socat \
  e2fsprogs \
  iptables \
  procps

# Node.js from edge — must upgrade libssl3/libcrypto3 first to match edge's Node
chroot "${MOUNTDIR}" apk upgrade --no-cache \
  --repository="${ALPINE_MIRROR}/edge/main" \
  libssl3 libcrypto3
chroot "${MOUNTDIR}" apk add --no-cache nodejs npm

# Verify Node.js version
NODE_VERSION=$(chroot "${MOUNTDIR}" node --version 2>/dev/null || echo "none")
echo "Node.js version: ${NODE_VERSION}"

# --- Install agent CLIs ---

echo "Installing agent CLIs..."

# Codex CLI
chroot "${MOUNTDIR}" npm install -g @openai/codex || {
  echo "WARNING: Failed to install Codex CLI" >&2
}

# Claude Code CLI
chroot "${MOUNTDIR}" npm install -g @anthropic-ai/claude-code || {
  echo "WARNING: Failed to install Claude Code CLI" >&2
}

# OpenCode
chroot "${MOUNTDIR}" sh -c 'curl -fsSL https://opencode.ai/install | bash' || {
  echo "WARNING: Failed to install OpenCode" >&2
}
# Copy opencode binary to PATH (not symlink — dev user can't access /root/)
if [ -f "${MOUNTDIR}/root/.opencode/bin/opencode" ]; then
  cp "${MOUNTDIR}/root/.opencode/bin/opencode" "${MOUNTDIR}/usr/local/bin/opencode"
  chmod 755 "${MOUNTDIR}/usr/local/bin/opencode"
fi

# PM2 process manager
chroot "${MOUNTDIR}" npm install -g pm2

# --- Create dev user ---

echo "Setting up dev user..."

chroot "${MOUNTDIR}" adduser -D -s /bin/bash dev
# Unlock account — OpenSSH 10+ rejects pubkey auth for locked accounts ("!" in shadow)
chroot "${MOUNTDIR}" sed -i 's/^dev:!:/dev:*:/' /etc/shadow
chroot "${MOUNTDIR}" sh -c 'echo "dev ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers'
mkdir -p "${MOUNTDIR}/home/dev/.ssh"
chmod 700 "${MOUNTDIR}/home/dev/.ssh"
chroot "${MOUNTDIR}" chown -R dev:dev /home/dev

# --- Configure SSH ---

echo "Configuring SSH..."

# Generate host keys
chroot "${MOUNTDIR}" ssh-keygen -A

# Configure sshd
cat > "${MOUNTDIR}/etc/ssh/sshd_config" <<'SSHD_CONF'
Port 22
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
ChallengeResponseAuthentication no
UsePAM no
X11Forwarding no
PrintMotd yes
AcceptEnv LANG LC_*
Subsystem sftp /usr/lib/ssh/sftp-server
SSHD_CONF

# --- Configure init system ---

echo "Configuring init..."

# Enable OpenRC services
chroot "${MOUNTDIR}" rc-update add sshd default 2>/dev/null || true

# Create a simple init script that will be PID 1
# This is the main entry point when Firecracker boots the VM
cat > "${MOUNTDIR}/sbin/deploymagi-init" <<'INIT'
#!/bin/bash
# DeployMagi VM init — executed as PID 1 by the kernel
# See vm/init.sh for the full version with overlayfs + env setup

set -e

# Mount essential filesystems
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev
mkdir -p /dev/pts /dev/shm
mount -t devpts devpts /dev/pts
mount -t tmpfs tmpfs /dev/shm
mount -t tmpfs tmpfs /run
mount -t tmpfs tmpfs /tmp

# Parse kernel cmdline for env vars
eval $(cat /proc/cmdline | tr ' ' '\n' | grep '^dm\.' | sed 's/^dm\./export DM_/' | sed 's/=\(.*\)/="\1"/')

# Run the actual init script
if [ -f /opt/deploymagi/init.sh ]; then
  exec /opt/deploymagi/init.sh
fi

# Fallback: just start SSH and wait
/usr/sbin/sshd -D &

# Keep PID 1 alive
exec sleep infinity
INIT
chmod +x "${MOUNTDIR}/sbin/deploymagi-init"

# Create the deploymagi dir for init script
mkdir -p "${MOUNTDIR}/opt/deploymagi"

# Copy the actual init script
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "${SCRIPT_DIR}/init.sh" ]; then
  cp "${SCRIPT_DIR}/init.sh" "${MOUNTDIR}/opt/deploymagi/init.sh"
  chmod +x "${MOUNTDIR}/opt/deploymagi/init.sh"
  echo "Installed init.sh to /opt/deploymagi/init.sh"
fi

# --- Create MOTD ---

cat > "${MOUNTDIR}/etc/motd" <<'MOTD'
  ____             _             __  __             _
 |  _ \  ___ _ __ | | ___  _   _|  \/  | __ _  __ _(_)
 | | | |/ _ \ '_ \| |/ _ \| | | | |\/| |/ _` |/ _` | |
 | |_| |  __/ |_) | | (_) | |_| | |  | | (_| | (_| | |
 |____/ \___| .__/|_|\___/ \__, |_|  |_|\__,_|\__, |_|
             |_|            |___/              |___/

  Your project is in ~/ — run `claude`, `codex`, or `opencode` there.

  Your GitHub SSH keys are pre-configured.
  Set ANTHROPIC_API_KEY or run `claude /login` to authenticate.
MOTD

# --- Create swap file ---

echo "Creating 1GB swap file..."
dd if=/dev/zero of="${MOUNTDIR}/swapfile" bs=1M count=1024 status=progress
chmod 600 "${MOUNTDIR}/swapfile"
mkswap "${MOUNTDIR}/swapfile"

# --- Cleanup ---

echo "Cleaning up rootfs..."

# Remove APK cache
rm -rf "${MOUNTDIR}/var/cache/apk/*"

# Remove npm cache (can be 100MB+)
rm -rf "${MOUNTDIR}/root/.npm" "${MOUNTDIR}/tmp/"*

# Remove resolv.conf (will be set at boot)
rm -f "${MOUNTDIR}/etc/resolv.conf"

# Unmount
umount "${MOUNTDIR}/dev"
umount "${MOUNTDIR}/sys"
umount "${MOUNTDIR}/proc"
umount "${MOUNTDIR}"
losetup -d "${LOOP}"

# Reset trap (cleanup already done)
trap - EXIT

echo ""
echo "=== Rootfs Built Successfully ==="
echo "Output: ${OUTPUT}"
echo "Size: $(du -h "${OUTPUT}" | awk '{print $1}')"
echo ""
echo "To use with Firecracker, set FC_ROOTFS=${OUTPUT} in your config."
